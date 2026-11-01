// Derived from LocalDevVPN's TunnelProv/PacketTunnelProvider.swift.
// Upstream: https://github.com/jkcoxson/LocalDevVPN
// Pinned commit: 02efcfe72f18b6d14f4e36178911c74265ddcaca
// Copyright (c) 2025 SideStore Team. See Vendor/LocalDevVPN/LICENSE.

import Foundation
import NetworkExtension

/// The proven LocalDevVPN packet loop, isolated as a reusable component.
///
/// `startExclusiveLoop()` preserves the upstream provider's read/modify/write
/// behavior. `recycle(_:protocolNumber:)` applies the same translation to one
/// packet so the Gelato iOS app can coexist with its Linux packet transport.
final class LocalDevVPNPacketRecycler {
    static let deviceAddress = "10.7.0.0"
    static let fakeAddress = "10.7.0.1"
    static let subnetMask = "255.255.255.0"
    static let overlayDeviceIPv4 = "198.18.0.2"
    static let overlayIPv4Network = "198.18.0.0"
    static let overlayIPv4Mask = "255.255.255.0"
    static let overlayDeviceIPv6 = "fd7a:115c:a1e0::2"
    static let overlayIPv6Network = "fd7a:115c:a1e0::"

    private let packetFlow: NEPacketTunnelFlow
    private let deviceAddressValue: UInt32
    private let fakeAddressValue: UInt32

    init(packetFlow: NEPacketTunnelFlow) {
        self.packetFlow = packetFlow
        deviceAddressValue = Self.ipToUInt32(Self.deviceAddress)
        fakeAddressValue = Self.ipToUInt32(Self.fakeAddress)
    }

    static func networkSettings() -> NEPacketTunnelNetworkSettings {
        let settings = NEPacketTunnelNetworkSettings(
            tunnelRemoteAddress: deviceAddress
        )
        let ipv4 = NEIPv4Settings(
            addresses: [deviceAddress, overlayDeviceIPv4],
            subnetMasks: [subnetMask, overlayIPv4Mask]
        )
        ipv4.includedRoutes = [
            NEIPv4Route(
                destinationAddress: deviceAddress,
                subnetMask: subnetMask
            ),
            // The pairable-host Bonjour record resolves to 198.18.0.1.
            // Without this route iOS can display the Linux host, but sends
            // the subsequent SRP TCP connection to the ordinary network
            // instead of the Packet Tunnel, so no six-digit PIN is created.
            NEIPv4Route(
                destinationAddress: overlayIPv4Network,
                subnetMask: overlayIPv4Mask
            )
        ]
        ipv4.excludedRoutes = [.default()]
        settings.ipv4Settings = ipv4
        let ipv6 = NEIPv6Settings(
            addresses: [overlayDeviceIPv6],
            networkPrefixLengths: [NSNumber(value: 64)]
        )
        ipv6.includedRoutes = [
            NEIPv6Route(
                destinationAddress: overlayIPv6Network,
                networkPrefixLength: NSNumber(value: 64)
            )
        ]
        settings.ipv6Settings = ipv6
        return settings
    }

    /// Runs the upstream LocalDevVPN provider loop without any other transport.
    func startExclusiveLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            var modified = packets
            for index in modified.indices
            where index < protocols.count
                && protocols[index].int32Value == AF_INET
                && modified[index].count >= 20 {
                self.translate(&modified[index])
            }
            self.packetFlow.writePackets(modified, withProtocols: protocols)
            self.startExclusiveLoop()
        }
    }

    /// Recycles a LocalDevVPN packet and returns false for Linux-overlay traffic.
    @discardableResult
    func recycle(_ packet: Data, protocolNumber: NSNumber) -> Bool {
        guard protocolNumber.int32Value == AF_INET, packet.count >= 20 else {
            return false
        }
        var modified = packet
        guard translate(&modified) else { return false }
        packetFlow.writePackets([modified], withProtocols: [protocolNumber])
        return true
    }

    @discardableResult
    private func translate(_ packet: inout Data) -> Bool {
        packet.withUnsafeMutableBytes { rawBytes in
            guard let words = rawBytes.baseAddress?
                .assumingMemoryBound(to: UInt32.self) else {
                return false
            }
            let source = UInt32(bigEndian: words[3])
            let destination = UInt32(bigEndian: words[4])
            var translated = false
            if source == deviceAddressValue {
                words[3] = fakeAddressValue.bigEndian
                translated = true
            }
            if destination == fakeAddressValue {
                words[4] = deviceAddressValue.bigEndian
                translated = true
            }
            return translated
        }
    }

    private static func ipToUInt32(_ address: String) -> UInt32 {
        let components = address.split(separator: ".")
        guard components.count == 4,
              let first = UInt32(components[0]),
              let second = UInt32(components[1]),
              let third = UInt32(components[2]),
              let fourth = UInt32(components[3]) else {
            return 0
        }
        return (first << 24) | (second << 16) | (third << 8) | fourth
    }
}
