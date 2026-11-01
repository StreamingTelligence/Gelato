import ReplayKit
import UIKit
import os

private enum BroadcastSharedConfig {
    static let appGroup = (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    static let controllerUrlKey = "controllerUrl"
    static let deviceIdKey = "deviceId"
    static let agentIdKey = "agentId"
    static let agentTokenKey = "agentToken"
    static let wdaBaseUrlKey = "wdaBaseUrl"
    static let iosBundleIdKey = "iosBundleId"
    static let iosUdidKey = "iosUdid"
    static let logFileName = "mobile-agent-broadcast.log"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    static var logFileUrl: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(logFileName)
    }
}

@objc(BroadcastSetupViewController)
final class BroadcastSetupViewController: UIViewController {
    private var didCompleteSetup = false
    private var completeAttempts = 0
    private let logger = Logger(subsystem: "dev.galatea.agent", category: "BroadcastSetup")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        trace("viewDidLoad")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.completeSetup()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        trace("viewDidAppear")
        completeSetup()
    }

    private func completeSetup() {
        guard !didCompleteSetup else { return }
        completeAttempts += 1
        guard let extensionContext else {
            trace("extensionContext unavailable attempt=\(completeAttempts)")
            if completeAttempts < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                    self?.completeSetup()
                }
            }
            return
        }
        didCompleteSetup = true
        let broadcastURL = URL(string: "https://gelato.invalid/broadcast")!
        guard let resolvedControllerUrl = controllerUrl() else {
            let message = "Controller URL is not configured for ReplayKit broadcast setup"
            trace(message)
            extensionContext.cancelRequest(withError: NSError(
                domain: "dev.galatea.agent.broadcastSetup",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            ))
            return
        }
        let resolvedDeviceId = deviceId()
        var setupInfo: [String: NSCoding & NSObjectProtocol] = [
            "controllerUrl": resolvedControllerUrl as NSString,
            "deviceId": resolvedDeviceId as NSString
        ]
        if let agentToken = sharedValue(BroadcastSharedConfig.agentTokenKey) {
            setupInfo["agentToken"] = agentToken as NSString
        }
        if let agentId = sharedValue(BroadcastSharedConfig.agentIdKey) {
            setupInfo["agentId"] = agentId as NSString
        }
        if let wdaBaseUrl = sharedValue(BroadcastSharedConfig.wdaBaseUrlKey) {
            setupInfo["wdaBaseUrl"] = wdaBaseUrl as NSString
        }
        if let iosBundleId = sharedValue(BroadcastSharedConfig.iosBundleIdKey) {
            setupInfo["iosBundleId"] = iosBundleId as NSString
        }
        if let iosUdid = sharedValue(BroadcastSharedConfig.iosUdidKey) {
            setupInfo["iosUdid"] = iosUdid as NSString
        }
        let resolvedWdaBaseUrl = setupInfo["wdaBaseUrl"].map { String(describing: $0) } ?? "<unset>"
        trace("completeRequest controllerUrl=\(resolvedControllerUrl) deviceId=\(resolvedDeviceId) wdaBaseUrl=\(resolvedWdaBaseUrl)")
        extensionContext.completeRequest(withBroadcast: broadcastURL, setupInfo: setupInfo)
    }

    private func controllerUrl() -> String? {
        if let shared = BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.controllerUrlKey),
           !shared.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return shared
        }
        guard let value = ProcessInfo.processInfo.environment["MOBILE_AGENT_CONTROLLER_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private func deviceId() -> String {
        if let shared = BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.deviceIdKey),
           !shared.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return shared
        }
        let vendor = UIDevice.current.identifierForVendor?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
        #if targetEnvironment(simulator)
        return "ios-simulator-\(vendor)"
        #else
        return "ios-device-\(vendor)"
        #endif
    }

    private func sharedValue(_ key: String) -> String? {
        guard let value = BroadcastSharedConfig.defaults?.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private func trace(_ message: String) {
        let line = "MobileAgentBroadcastSetup \(message)"
        logger.error("\(line, privacy: .public)")
        NSLog("%@", line)
        guard let fileUrl = BroadcastSharedConfig.logFileUrl else { return }
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        guard let data = entry.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: fileUrl.path),
           let handle = try? FileHandle(forWritingTo: fileUrl) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: fileUrl, options: .atomic)
        }
    }
}
