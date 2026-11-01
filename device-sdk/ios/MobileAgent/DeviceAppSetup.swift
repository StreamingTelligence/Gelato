import Foundation

enum DeviceAppErrorRecovery {
    // Only retire the failure proven resolved by the successful health probe.
    // Permission, pairing, update and newer unrelated errors must remain visible.
    static func afterSuccessfulEngineProbe(current: String, recordedEngineFailure: String?) -> String {
        guard let recordedEngineFailure, !recordedEngineFailure.isEmpty,
              current == recordedEngineFailure else { return current }
        return ""
    }
}

/// Presentation policy only. System authorization and pairing stay in their
/// existing native coordinators; service discovery is never proof of pairing.
struct DeviceAppSetup {
    var iosMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    var notificationState = "NOTIFICATION_UNKNOWN"
    var localNetworkState = "LOCAL_NETWORK_UNKNOWN"
    var vpnState = "VPN_STOPPED"
    var pairingState = "PAIRING_IDLE"
    var engineReady = false
    var packetTunnelRemoteXpcState = ""
    var mainAppRemoteXpcState = ""
    var activePermissionRequest: String?

    var steps: [[String: Any]] {
        func step(_ id: String, _ title: String, _ detail: String, _ state: String,
                  _ basis: String, _ action: String, _ button: String, disabled: Bool = false,
                  phase: String = "before-control", required: Bool = true,
                  secondaryAction: String? = nil, secondaryButton: String? = nil) -> [String: Any] {
            var value: [String: Any] = ["id": id, "title": title, "detail": detail,
                "done": state == "passed", "check": ["state": state, "basis": basis],
                "phase": phase, "required": required,
                "disabled": disabled || activePermissionRequest != nil]
            if !action.isEmpty && !button.isEmpty {
                value["action"] = action
                value["button"] = button
            }
            if let secondaryAction, let secondaryButton {
                value["secondaryAction"] = secondaryAction
                value["secondaryButton"] = secondaryButton
            }
            return value
        }
        let tunnelStates = [packetTunnelRemoteXpcState, mainAppRemoteXpcState]
        let liveTunnelStates = vpnState == "VPN_CONNECTED" ? tunnelStates : []
        let wdaReady = engineReady || liveTunnelStates.contains("wdaReady")
        let wdaInstalled = liveTunnelStates.contains("wdaInstalled")
        let wdaStarting = liveTunnelStates.contains("wdaStarting")
        let wdaInstalling = liveTunnelStates.contains {
            ["wdaInstallRequested", "wdaInstalling"].contains($0)
        }
        let wdaMissing = liveTunnelStates.contains {
            $0.hasPrefix("wdaStartError:") &&
                ($0.localizedCaseInsensitiveContains("AppNotInstalled") ||
                 $0.localizedCaseInsensitiveContains("not installed"))
        }
        let wdaInstallError = liveTunnelStates.contains { $0.hasPrefix("wdaInstallError:") }
        // An installed runner is not a working WDA. Only a live /status probe
        // from the app or Packet Tunnel can satisfy this prerequisite.
        let wdaState = wdaReady ? "passed" :
            (wdaInstalling || wdaStarting) ? "checking" :
            (wdaMissing || wdaInstallError) ? "failed" :
            wdaInstalled ? "checking" : "unknown"
        let wdaBasis = wdaState == "unknown" ? "none" : "probe"
        // A controller confirmation or a saved pairing record is not proof of
        // current system pairing. A working RemoteXPC driver is evidence.
        let pairingProven = engineReady || liveTunnelStates.contains {
            $0 == "rsdReady" || $0 == "wdaReady" || $0 == "wdaInstalled" ||
            $0 == "wdaInstalling" || $0 == "wdaStarting" ||
            $0.hasPrefix("wdaStartError:")
        }
        let hostVisible = ["PAIRING_SYSTEM_UI_READY", "PAIRING_SYSTEM_UI_OPENING",
                           "PAIRING_SYSTEM_UI_OPENED", "PAIRING_SYSTEM_UI_MANUAL",
                           "PAIRING_SYSTEM_UI_UNAVAILABLE"].contains(pairingState)
        let notificationDenied = notificationState == "NOTIFICATION_DENIED"
        let networkDenied = localNetworkState == "LOCAL_NETWORK_DENIED"
        let vpnStarting = ["VPN_CONFIGURING", "VPN_CONNECTING", "VPN_STARTING", "VPN_RESTARTING"].contains(vpnState)
        let ios27OrNewer = iosMajorVersion >= 27
        return [
            step("ios-version", "检查 iOS 版本", "无线系统配对与控制需要 iOS 27 或更新版本。",
                 ios27OrNewer ? "passed" : "failed", "system", "", "", phase: "before-pairing"),
            step("developer", "确认开发者模式", "在“隐私与安全性 → 开发者模式”中开启，按系统提示重启并再次确认。",
                 engineReady ? "passed" : "unknown", engineReady ? "inference" : "none",
                 "developer", "打开开发者模式", phase: "before-pairing"),
            step("notifications", "让配对码及时送达",
                 notificationDenied ? "通知曾被拒绝。请在系统设置中允许通知，返回后会自动检测。" : "允许通知后，六位配对码会直接弹出，不用往返控制页面查找。",
                 notificationState == "NOTIFICATION_READY" ? "passed" : notificationDenied ? "failed" : "unknown",
                 notificationState == "NOTIFICATION_READY" || notificationDenied ? "system" : "none",
                 notificationDenied ? "settings" : "notifications",
                 activePermissionRequest == "NOTIFICATIONS" ? "等待通知授权…" : notificationDenied ? "打开通知设置" : "允许通知", phase: "before-pairing"),
            step("network", "允许本地网络访问",
                 networkDenied ? "请在系统设置中允许本地网络访问，返回后会重新检测。" : "配对需要与 iPhone 的系统服务通信。接下来仅申请本地网络权限。",
                 localNetworkState == "LOCAL_NETWORK_READY" ? "passed" : networkDenied ? "failed" : "unknown",
                 localNetworkState == "LOCAL_NETWORK_READY" ? "probe" : networkDenied ? "system" : "none",
                 networkDenied ? "settings" : "network",
                 activePermissionRequest == "LOCAL_NETWORK" ? "正在检测本地网络…" : networkDenied ? "打开本地网络设置" : "允许本地网络", phase: "before-pairing",
                 secondaryAction: networkDenied ? "network" : nil, secondaryButton: networkDenied ? "重新检测" : nil),
            step("vpn", "建立安全的设备通道", "首次连接时，系统会询问是否添加 VPN 配置。这是设备助手与 Linux 控制端之间的通道，原系统配对会保留。",
                 vpnState == "VPN_CONNECTED" ? "passed" : vpnState == "VPN_ERROR" ? "failed" : vpnStarting ? "checking" : "unknown",
                 vpnState == "VPN_CONNECTED" || vpnState == "VPN_ERROR" ? "system" : "none",
                 "vpn", vpnStarting ? "正在建立设备通道…" : "连接设备通道", disabled: vpnStarting),
            step("pairing", "验证 iPhone 系统配对",
                 hostVisible || pairingProven
                    ? "配对主机已就绪。请手动打开“设置 → 隐私与安全性 → 开发者模式 → 其他设备”，选择 Linux 主机。六位配对码会通过通知送达；RemoteXPC 连通后才会确认完成。"
                    : "尚未验证当前系统配对。先打开允许接入控制并连接设备通道；发现系统服务或保存了旧记录都不代表配对仍有效。",
                 pairingProven ? "passed" : hostVisible ? "checking" : "unknown",
                 pairingProven ? "probe" : "none",
                 hostVisible || pairingProven ? "" : "pairing",
                 hostVisible || pairingProven ? "" : "等待配对主机…", disabled: !hostVisible && !pairingProven),
            step("wda", "检查 WebDriverAgent",
                 wdaState == "failed"
                    ? "未检测到可用的 WDA，或安装失败。请让控制端提供为本机签名的 WDA 安装包，并保持设备通道连接；安装由控制端触发。"
                    : wdaInstalling ? "控制端正在安装 WDA，请保持设备通道连接。"
                    : (wdaInstalled || wdaStarting) && !wdaReady
                        ? "WDA 已安装，正在启动并验证 /status；安装记录本身不代表可用。"
                    : "系统配对后将自动检查 WDA；若未安装，控制端需提供为本机签名的安装包。",
                 wdaState, wdaBasis, "wda-check", "重新检测", disabled: wdaInstalling || wdaStarting)
        ]
    }

    var prePairingBlocker: String? {
        steps.first { ($0["phase"] as? String) == "before-pairing"
            && ($0["required"] as? Bool) == true
            && (($0["check"] as? [String: String])?["state"] == "failed") }?["title"] as? String
    }
}
