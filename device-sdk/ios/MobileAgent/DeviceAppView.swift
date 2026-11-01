import SwiftUI
import Capacitor

struct DeviceAppView: UIViewControllerRepresentable {
    let runtime: AgentRuntime
    func makeUIViewController(context: Context) -> DeviceAppController { DeviceAppController(runtime: runtime) }
    func updateUIViewController(_ controller: DeviceAppController, context: Context) {}
}

final class DeviceAppController: CAPBridgeViewController {
    let runtime: AgentRuntime
    init(runtime: AgentRuntime) { self.runtime = runtime; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use init(runtime:)") }
    override func instanceDescriptor() -> InstanceDescriptor {
        let value = super.instanceDescriptor()
        value.loggingBehavior = .none
        #if SWIFT_PACKAGE
        value.appLocation = Bundle.module.resourceURL!.appendingPathComponent("public")
        #endif
        return value
    }
    override func capacitorDidLoad() {
        let plugin = DeviceAppPlugin()
        plugin.runtime = runtime
        bridge?.registerPluginInstance(plugin)
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }
}

@objc(DeviceAppPlugin)
final class DeviceAppPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "DeviceAppPlugin"
    let jsName = "DeviceApp"
    let pluginMethods = [CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)!]
    weak var runtime: AgentRuntime?
    @objc func request(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let runtime else { throw AgentError.message("设备服务正在启动，请重试") }
                let value = try await runtime.deviceAppRequest(call.options as? [String: Any] ?? [:])
                call.resolve(value)
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
