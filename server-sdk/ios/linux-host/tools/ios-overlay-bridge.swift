import Foundation
import Darwin

private let defaultMacAddress = "198.18.0.1"
private let defaultIosAddress = "198.18.0.2"
private let defaultSubnetMask = "255.255.255.0"
private let defaultMacIPv6Address = "fd7a:115c:a1e0::1"
private let defaultIosIPv6Address = "fd7a:115c:a1e0::2"
private let defaultIPv6PrefixLength = "64"
private let defaultMtu = "1280"
private let ctlIoCgInfo = CUnsignedLong(0xC0000000)
    | CUnsignedLong((MemoryLayout<ctl_info>.size & 0x1fff) << 16)
    | CUnsignedLong(UInt8(ascii: "N")) << 8
    | CUnsignedLong(3)

final class OverlayBridge: NSObject, URLSessionWebSocketDelegate {
    private let webSocketUrl: URL
    private let macAddress: String
    private let iosAddress: String
    private let subnetMask: String
    private let macIPv6Address: String?
    private let iosIPv6Address: String?
    private let ipv6PrefixLength: String
    private let mtu: String
    private let configureInterface: Bool
    private let queue = DispatchQueue(label: "serverized.ios-overlay-bridge")
    private var fd: Int32 = -1
    private var ifname = ""
    private var readSource: DispatchSourceRead?
    private var session: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var reconnectWorkItem: DispatchWorkItem?

    init(
        webSocketUrl: URL,
        macAddress: String,
        iosAddress: String,
        subnetMask: String,
        macIPv6Address: String?,
        iosIPv6Address: String?,
        ipv6PrefixLength: String,
        mtu: String,
        configureInterface: Bool
    ) {
        self.webSocketUrl = webSocketUrl
        self.macAddress = macAddress
        self.iosAddress = iosAddress
        self.subnetMask = subnetMask
        self.macIPv6Address = macIPv6Address
        self.iosIPv6Address = iosIPv6Address
        self.ipv6PrefixLength = ipv6PrefixLength
        self.mtu = mtu
        self.configureInterface = configureInterface
    }

    func start() throws {
        let opened = try openUtun()
        fd = opened.fd
        ifname = opened.ifname
        if configureInterface {
            try configureUtun()
        }
        connectWebSocket()
        startReadingUtun()
        startPingTimer()
        let ipv6Summary = macIPv6Address.flatMap { macIPv6 in
            iosIPv6Address.map { iosIPv6 in " mac6=\(macIPv6) ios6=\(iosIPv6)/\(ipv6PrefixLength)" }
        } ?? ""
        print("READY ifname=\(ifname) mac=\(macAddress) ios=\(iosAddress)\(ipv6Summary) websocket=\(webSocketUrl.absoluteString)")
    }

    private func openUtun() throws -> (fd: Int32, ifname: String) {
        let socketFd = socket(PF_SYSTEM, SOCK_DGRAM, SYSPROTO_CONTROL)
        if socketFd < 0 {
            throw BridgeError.system("socket(PF_SYSTEM)", errno)
        }

        var info = ctl_info()
        let ctlNameSize = MemoryLayout.size(ofValue: info.ctl_name)
        _ = withUnsafeMutablePointer(to: &info.ctl_name) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: ctlNameSize) { namePointer in
                strncpy(namePointer, UTUN_CONTROL_NAME, ctlNameSize)
            }
        }
        if ioctl(socketFd, ctlIoCgInfo, &info) < 0 {
            close(socketFd)
            throw BridgeError.system("ioctl(CTLIOCGINFO)", errno)
        }

        var address = sockaddr_ctl()
        address.sc_len = UInt8(MemoryLayout<sockaddr_ctl>.size)
        address.sc_family = UInt8(AF_SYSTEM)
        address.ss_sysaddr = UInt16(AF_SYS_CONTROL)
        address.sc_id = info.ctl_id
        address.sc_unit = 0

        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(socketFd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_ctl>.size))
            }
        }
        if connected < 0 {
            close(socketFd)
            throw BridgeError.system("connect(utun)", errno)
        }

        var nameBuffer = [CChar](repeating: 0, count: Int(IFNAMSIZ))
        var nameLength = socklen_t(IFNAMSIZ)
        let gotName = nameBuffer.withUnsafeMutableBufferPointer { buffer in
            getsockopt(socketFd, SYSPROTO_CONTROL, UTUN_OPT_IFNAME, buffer.baseAddress, &nameLength)
        }
        if gotName < 0 {
            close(socketFd)
            throw BridgeError.system("getsockopt(UTUN_OPT_IFNAME)", errno)
        }
        let flags = fcntl(socketFd, F_GETFL)
        if flags < 0 || fcntl(socketFd, F_SETFL, flags | O_NONBLOCK) < 0 {
            let savedErrno = errno
            close(socketFd)
            throw BridgeError.system("fcntl(O_NONBLOCK)", savedErrno)
        }
        return (socketFd, String(cString: nameBuffer))
    }

    private func configureUtun() throws {
        try run("/sbin/ifconfig", [
            ifname,
            "inet",
            macAddress,
            iosAddress,
            "netmask",
            subnetMask,
            "mtu",
            mtu,
            "up"
        ])
        _ = try? run("/sbin/route", ["-n", "add", "-host", iosAddress, "-interface", ifname])
        guard let macIPv6Address, let iosIPv6Address else { return }
        try run("/sbin/ifconfig", [
            ifname,
            "inet6",
            macIPv6Address,
            "prefixlen",
            ipv6PrefixLength,
            "up"
        ])
        _ = try? run("/sbin/route", ["-n", "add", "-inet6", "-host", iosIPv6Address, "-interface", ifname])
    }

    private func connectWebSocket() {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 0
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: webSocketUrl)
        self.session = session
        webSocketTask = task
        task.resume()
        receiveWebSocket(task)
    }

    private func startReadingUtun() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            self?.drainUtun()
        }
        source.setCancelHandler { [fd] in
            if fd >= 0 { close(fd) }
        }
        readSource = source
        source.resume()
    }

    private func drainUtun() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count > 4 {
                let packet = Data(buffer[4..<count])
                webSocketTask?.send(.data(packet)) { error in
                    if let error {
                        fputs("WARN websocket send failed: \(error.localizedDescription)\n", stderr)
                        self.scheduleReconnect(reason: "send failed")
                    }
                }
            } else if count == -1 && (errno == EWOULDBLOCK || errno == EAGAIN) {
                return
            } else {
                return
            }
        }
    }

    private func receiveWebSocket(_ task: URLSessionWebSocketTask? = nil) {
        guard let activeTask = task ?? webSocketTask else { return }
        activeTask.receive { [weak self] result in
            guard let self else { return }
            guard activeTask === self.webSocketTask else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let packet):
                    self.writePacketToUtun(packet)
                case .string(let text):
                    fputs("INFO websocket control: \(text)\n", stderr)
                @unknown default:
                    break
                }
                self.receiveWebSocket(activeTask)
            case .failure(let error):
                fputs("ERROR websocket receive failed: \(error.localizedDescription)\n", stderr)
                self.scheduleReconnect(reason: "receive failed")
            }
        }
    }

    private func writePacketToUtun(_ packet: Data) {
        guard !packet.isEmpty else { return }
        var family = UInt32(packet.first! >> 4 == 6 ? AF_INET6 : AF_INET).bigEndian
        var data = Data(bytes: &family, count: MemoryLayout<UInt32>.size)
        data.append(packet)
        data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            var written = 0
            while written < rawBuffer.count {
                let result = Darwin.write(fd, baseAddress.advanced(by: written), rawBuffer.count - written)
                if result <= 0 { return }
                written += result
            }
        }
    }

    private func startPingTimer() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 10, repeating: 10)
        timer.setEventHandler { [weak self] in
            guard let self, let task = self.webSocketTask else { return }
            task.sendPing { error in
                if let error {
                    fputs("WARN websocket ping failed: \(error.localizedDescription)\n", stderr)
                    self.scheduleReconnect(reason: "ping failed")
                }
            }
        }
        pingTimer = timer
        timer.resume()
    }

    private func scheduleReconnect(reason: String) {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.reconnectWorkItem == nil else { return }
            fputs("WARN websocket reconnect scheduled after \(reason)\n", stderr)
            let task = self.webSocketTask
            self.webSocketTask = nil
            task?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.session = nil
            let workItem = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.queue.async {
                    self.reconnectWorkItem = nil
                    self.connectWebSocket()
                }
            }
            self.reconnectWorkItem = workItem
            self.queue.asyncAfter(deadline: .now() + 2, execute: workItem)
        }
    }

    private func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            throw BridgeError.command("\(executable) \(arguments.joined(separator: " "))", output)
        }
    }
}

enum BridgeError: Error, CustomStringConvertible {
    case usage(String)
    case system(String, Int32)
    case command(String, String)

    var description: String {
        switch self {
        case .usage(let message):
            return message
        case .system(let call, let err):
            return "\(call) failed: \(String(cString: strerror(err)))"
        case .command(let command, let output):
            return "\(command) failed: \(output)"
        }
    }
}

struct Arguments {
    var webSocketUrl: URL?
    var controllerUrl: String?
    var deviceId: String?
    var token: String?
    var macAddress = defaultMacAddress
    var iosAddress = defaultIosAddress
    var subnetMask = defaultSubnetMask
    var macIPv6Address: String? = defaultMacIPv6Address
    var iosIPv6Address: String? = defaultIosIPv6Address
    var ipv6PrefixLength = defaultIPv6PrefixLength
    var mtu = defaultMtu
    var configureInterface = true
}

func parseArguments(_ raw: [String]) throws -> Arguments {
    var args = Arguments()
    var index = 1
    while index < raw.count {
        let key = raw[index]
        func requireValue() throws -> String {
            guard index + 1 < raw.count else { throw BridgeError.usage("Missing value for \(key)") }
            index += 1
            return raw[index]
        }
        switch key {
        case "--websocket-url":
            args.webSocketUrl = URL(string: try requireValue())
        case "--controller-url":
            args.controllerUrl = try requireValue()
        case "--device-id":
            args.deviceId = try requireValue()
        case "--token":
            args.token = try requireValue()
        case "--mac-address":
            args.macAddress = try requireValue()
        case "--ios-address":
            args.iosAddress = try requireValue()
        case "--subnet-mask":
            args.subnetMask = try requireValue()
        case "--mac-ipv6-address":
            args.macIPv6Address = try requireValue()
        case "--ios-ipv6-address":
            args.iosIPv6Address = try requireValue()
        case "--ipv6-prefix-length":
            args.ipv6PrefixLength = try requireValue()
        case "--no-ipv6":
            args.macIPv6Address = nil
            args.iosIPv6Address = nil
        case "--mtu":
            args.mtu = try requireValue()
        case "--no-configure-interface":
            args.configureInterface = false
        case "--help", "-h":
            throw BridgeError.usage("""
            Usage:
              ios-overlay-bridge --websocket-url ws(s)://controller/packet-overlay/<device>?role=mac&token=...
              ios-overlay-bridge --controller-url https://relay --device-id <id> --token <mac-token>
            """)
        default:
            throw BridgeError.usage("Unknown argument: \(key)")
        }
        index += 1
    }
    if args.webSocketUrl == nil {
        guard let controllerUrl = args.controllerUrl,
              let deviceId = args.deviceId,
              let token = args.token,
              var components = URLComponents(string: controllerUrl) else {
            throw BridgeError.usage("Provide --websocket-url, or --controller-url with --device-id and --token")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let encodedDeviceId = deviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? deviceId
        components.path = basePath.isEmpty
            ? "/packet-overlay/\(encodedDeviceId)"
            : "/\(basePath)/packet-overlay/\(encodedDeviceId)"
        components.queryItems = [
            URLQueryItem(name: "role", value: "mac"),
            URLQueryItem(name: "token", value: token)
        ]
        args.webSocketUrl = components.url
    }
    guard args.webSocketUrl != nil else {
        throw BridgeError.usage("Invalid WebSocket URL")
    }
    return args
}

setbuf(stdout, nil)
setbuf(stderr, nil)

do {
    let arguments = try parseArguments(CommandLine.arguments)
    let bridge = OverlayBridge(
        webSocketUrl: arguments.webSocketUrl!,
        macAddress: arguments.macAddress,
        iosAddress: arguments.iosAddress,
        subnetMask: arguments.subnetMask,
        macIPv6Address: arguments.macIPv6Address,
        iosIPv6Address: arguments.iosIPv6Address,
        ipv6PrefixLength: arguments.ipv6PrefixLength,
        mtu: arguments.mtu,
        configureInterface: arguments.configureInterface
    )
    try bridge.start()
    RunLoop.main.run()
} catch {
    fputs("ERROR \(error)\n", stderr)
    exit(1)
}
