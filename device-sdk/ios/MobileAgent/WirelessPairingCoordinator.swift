import Foundation
import UIKit
import os

/// Tracks whether the Packet Tunnel has made the Linux PairableHost visible.
///
/// Third-party applications are not entitled to create a
/// RemotePairingDevice pairing-management session themselves. The system
/// Settings application is, and owns the user-presence, passcode, host
/// selection, and PIN-entry flow.
@MainActor
final class WirelessPairingCoordinator {
    static let shared = WirelessPairingCoordinator()

    typealias StateHandler = (String, String?) -> Void

    private let logger = Logger(
        subsystem: "dev.galatea.agent",
        category: "WirelessPairing"
    )
    private var expectedIdentifier: String?
    private var stateHandler: StateHandler?
    private var openGeneration = 0

    private init() {}

    func start(expectedIdentifier: String, stateHandler: @escaping StateHandler) {
        let normalized = expectedIdentifier
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased()
        guard UUID(uuidString: normalized) != nil else {
            stateHandler(
                "PAIRING_INVALID_HOST",
                "The overlay did not provide a valid host identifier"
            )
            return
        }

        self.expectedIdentifier = normalized
        self.stateHandler = stateHandler
        emit(
            "PAIRING_SYSTEM_UI_READY",
            "The Linux host is visible. Continue when you are ready to leave the app."
        )
    }

    func openSystemPairingSettings() {
        guard expectedIdentifier != nil else {
            emit(
                "PAIRING_WAITING_FOR_PROXY",
                "Start the VPN and wait for the Linux pairing service"
            )
            return
        }
        // The Settings-navigation URL is not a public, reliable iOS API. A
        // failed open can show a misleading "could not connect to server"
        // alert and must never turn a visible host into a waiting host.
        emit(
            "PAIRING_SYSTEM_UI_MANUAL",
            "Open Settings > Privacy & Security > Developer Mode > Other Devices and select the Linux host"
        )
    }

    func openDeveloperModeSettings(stateHandler: @escaping StateHandler) {
        self.stateHandler = stateHandler
        openGeneration += 1
        let generation = openGeneration
        emit("DEVELOPER_MODE_SETTINGS_OPENING")
        let candidates = [
            "settings-navigation://com.apple.settings.PrivacyAndSecuritySettings/DeveloperMode",
            "settings-navigation://com.apple.settings.PrivacyAndSecuritySettings",
        ].compactMap(URL.init(string:))
        openFirstAvailable(
            candidates,
            generation: generation,
            openedState: "DEVELOPER_MODE_SETTINGS_OPENED",
            openedDetail: "Find Developer Mode, enable it, restart the iPhone, and confirm after restart",
            unavailableDetail: "Open Settings > Privacy & Security > Developer Mode"
        )
    }

    func stop() {
        openGeneration += 1
        expectedIdentifier = nil
        stateHandler = nil
    }

    private func openFirstAvailable(
        _ urls: [URL],
        generation: Int,
        openedState: String,
        openedDetail: String,
        unavailableDetail: String
    ) {
        guard generation == openGeneration else { return }
        guard let url = urls.first else {
            emit("PAIRING_SYSTEM_UI_UNAVAILABLE", unavailableDetail)
            return
        }

        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            Task { @MainActor in
                guard let self, generation == self.openGeneration else { return }
                if opened {
                    self.emit(openedState, openedDetail)
                } else {
                    self.openFirstAvailable(
                        Array(urls.dropFirst()),
                        generation: generation,
                        openedState: openedState,
                        openedDetail: openedDetail,
                        unavailableDetail: unavailableDetail
                    )
                }
            }
        }
    }

    private func emit(_ state: String, _ detail: String? = nil) {
        logger.info("state=\(state, privacy: .public)")
        stateHandler?(state, detail)
    }
}
