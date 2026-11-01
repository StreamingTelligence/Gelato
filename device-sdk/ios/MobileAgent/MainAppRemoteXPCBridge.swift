import Foundation
import Darwin
import os

#if canImport(idevice)
import idevice
#endif

/// Starts RemoteXPC from the containing app process.
///
/// LocalDevVPN-style address recycling is designed for a connection made by
/// an app through the packet tunnel. A connection originated by the packet
/// tunnel provider itself can complete the outer TLS/CDTunnel handshake on
/// iOS 27 while every inner RSD SYN is silently discarded. Keeping this
/// bootstrap in the containing app matches the proven on-device topology;
/// the Packet Tunnel remains the long-lived public control channel.
final class MainAppRemoteXPCBridge: @unchecked Sendable {
    static let shared = MainAppRemoteXPCBridge()

    private static let appGroup =
        (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    private static let pairRecordFileName = "remote-pairing.plist"
    private static let packetTunnelRemoteXpcStateKey =
        "packetTunnelRemoteXpcState"
    private static let wdaRunnerBundleId =
        (Bundle.main.object(forInfoDictionaryKey: "GalateaWdaRunnerBundleIdentifier") as? String ?? "dev.galatea.wda.xctrunner")

    private let queue = DispatchQueue(
        label: "serverized.main-app-remotexpc"
    )
    private let logger = Logger(
        subsystem: "dev.galatea.agent",
        category: "MainAppRemoteXPC"
    )
    private var running = false
    private var retryAfter = Date.distantPast
    private var ideviceLoggerStarted = false

#if canImport(idevice)
    private var adapter: OpaquePointer?
    private var handshake: OpaquePointer?
#if GALATEA_IDEVICE_XCTEST
    private var wdaRun: OpaquePointer?
#endif
#endif

    private init() {}

    func startIfAvailable() {
        queue.async {
            let defaults = UserDefaults(suiteName: Self.appGroup)
            // A periodic health refresh or an already-queued start must not
            // restart XCTest after the owner pauses control.
            guard defaults?.bool(forKey: "controlAllowed") == true else { return }
            let publishedState = defaults?.string(
                forKey: "mainAppRemoteXpcState"
            ) ?? ""
            let packetTunnelState = defaults?.string(
                forKey: Self.packetTunnelRemoteXpcStateKey
            ) ?? ""
            if self.running,
               publishedState.hasPrefix("wdaLost:")
                || publishedState.hasPrefix("wdaNotReady:") {
                self.releaseHandlesOnQueue()
                self.running = false
            }
            // The Packet Tunnel survives when this app is suspended, so it
            // must get exclusive first chance to own RemoteXPC and XCTest.
            // Starting a second adapter from the app races testmanagerd and
            // can produce "device socket io failed" in the extension. The app
            // remains a foreground-only fallback after a concrete extension
            // failure is published through the shared App Group.
            guard ![
                "waitingForPairRecord",
                "connecting",
                "wdaInstalling",
                "wdaInstalled",
                "wdaStarting",
                "wdaReady"
            ].contains(packetTunnelState) else {
                return
            }
            guard !self.running,
                  Date() >= self.retryAfter,
                  let pairRecordURL = self.pairRecordURL(),
                  let record = try? Data(
                    contentsOf: pairRecordURL
                  ),
                  !record.isEmpty,
                  record.count <= 4096 else {
                return
            }
            self.startOnQueue(pairRecord: record)
        }
    }

    func stop() {
        queue.sync {
            self.releaseHandlesOnQueue()
            running = false
            publish("idle")
        }
    }

    private func pairRecordURL() -> URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        )?.appendingPathComponent(Self.pairRecordFileName)
    }

    private func publish(_ state: String) {
        UserDefaults(suiteName: Self.appGroup)?.set(
            state,
            forKey: "mainAppRemoteXpcState"
        )
        logger.info("state=\(state, privacy: .public)")
    }

    private func startOnQueue(pairRecord: Data) {
        running = true
        publish("connecting")

#if canImport(idevice)
        if !ideviceLoggerStarted {
            let trace = IdeviceLogLevel(rawValue: 5)
            let disabled = IdeviceLogLevel(rawValue: 0)
            _ = idevice_init_logger(trace, disabled, nil)
            ideviceLoggerStarted = true
        }
        var pairingFile: OpaquePointer?
        let parseError = pairRecord.withUnsafeBytes { bytes in
            rp_pairing_file_from_bytes(
                bytes.bindMemory(to: UInt8.self).baseAddress,
                UInt(bytes.count),
                &pairingFile
            )
        }
        if let parseError {
            let detail = message(parseError)
            idevice_error_free(parseError)
            fail("recordError:\(detail)")
            return
        }
        guard let pairingFile else {
            fail("recordError:missingHandle")
            return
        }
        defer { rp_pairing_file_free(pairingFile) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(49152).bigEndian
        guard "10.7.0.1".withCString({
            inet_pton(AF_INET, $0, &address.sin_addr)
        }) == 1 else {
            fail("addressError")
            return
        }

        var newAdapter: OpaquePointer?
        var newHandshake: OpaquePointer?
        let tunnelError = "ServerizedMobileAgent".withCString { hostname in
            withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(
                    to: sockaddr.self,
                    capacity: 1
                ) { socketAddress in
#if GALATEA_IDEVICE_MAIN_CLEAN
                    tunnel_create_rppairing(
                        socketAddress,
                        socklen_t(MemoryLayout<sockaddr_in>.stride),
                        0,
                        hostname,
                        pairingFile,
                        nil,
                        nil,
                        &newAdapter,
                        &newHandshake
                    )
#else
                    tunnel_create_rppairing(
                        socketAddress,
                        socklen_t(MemoryLayout<sockaddr_in>.stride),
                        0,
                        hostname,
                        pairingFile,
                        nil,
                        nil,
                        &newAdapter,
                        &newHandshake
                    )
#endif
                }
            }
        }
        if let tunnelError {
            let detail = message(tunnelError)
            idevice_error_free(tunnelError)
            fail("tunnelError:\(detail)")
            return
        }
        guard newAdapter != nil, newHandshake != nil else {
            if let newHandshake {
                rsd_handshake_free(newHandshake)
            }
            if let newAdapter {
                adapter_free(newAdapter)
            }
            fail("tunnelError:missingHandle")
            return
        }
#if GALATEA_IDEVICE_MAIN_CLEAN
#if GALATEA_IDEVICE_XCTEST
        // The clean main-app FFI transfers both single-owner RSD handles to
        // the XCTest run below and clears these local slots.
#else
        adapter = newAdapter
        handshake = newHandshake
#endif
#else
        adapter = newAdapter
        handshake = newHandshake
#endif

#if GALATEA_IDEVICE_XCTEST
        let majorVersion =
            ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        guard majorVersion >= 17, majorVersion <= Int(UInt8.max) else {
            fail("wdaStartError:unsupportedIOSVersion")
            return
        }
        var newWdaRun: OpaquePointer?
        let startError = Self.wdaRunnerBundleId.withCString { bundleId in
#if GALATEA_IDEVICE_MAIN_CLEAN
            xctest_wda_start_rsd(
                &newAdapter,
                &newHandshake,
                bundleId,
                UInt8(majorVersion),
                &newWdaRun
            )
#else
            xctest_wda_start_rsd(
                newAdapter,
                newHandshake,
                bundleId,
                UInt8(majorVersion),
                &newWdaRun
            )
#endif
        }
        if let startError {
            let detail = message(startError)
            idevice_error_free(startError)
            fail("wdaStartError:\(detail)")
            return
        }
        guard let newWdaRun else {
            fail("wdaStartError:missingHandle")
            return
        }
        wdaRun = newWdaRun
        publish("wdaStarting")
#else
        publish("rsdReady")
#endif
#else
        fail("ideviceUnavailable")
#endif
    }

    private func fail(_ state: String) {
        releaseHandlesOnQueue()
        publish(state)
        running = false
        retryAfter = Date().addingTimeInterval(3)
    }

#if canImport(idevice)
    private func releaseHandlesOnQueue() {
#if GALATEA_IDEVICE_XCTEST
        if let wdaRun {
            xctest_wda_run_free(wdaRun)
            self.wdaRun = nil
        }
#endif
        if let handshake {
            rsd_handshake_free(handshake)
            self.handshake = nil
        }
        if let adapter {
            adapter_free(adapter)
            self.adapter = nil
        }
    }

    private func message(
        _ error: UnsafeMutablePointer<IdeviceFfiError>
    ) -> String {
        guard let pointer = error.pointee.message,
              let value = String(validatingUTF8: pointer) else {
            return "code\(error.pointee.code)"
        }
        return value.prefix(160).replacingOccurrences(
            of: "\n",
            with: " "
        )
    }
#else
    private func releaseHandlesOnQueue() {}
#endif
}
