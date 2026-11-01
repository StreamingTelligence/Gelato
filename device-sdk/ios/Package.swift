// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "MobileAgent",
    platforms: [.iOS("27.0")],
    products: [
        .library(name: "MobileAgent", targets: ["MobileAgent"]),
        .library(name: "PacketTunnel", targets: ["PacketTunnel"]),
        .library(name: "ScreenBroadcast", targets: ["ScreenBroadcast"]),
        .library(name: "ScreenBroadcastSetup", targets: ["ScreenBroadcastSetup"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "7.4.3")
    ],
    targets: [
        .target(
            name: "MobileAgent",
            dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm"), .product(name: "Cordova", package: "capacitor-swift-pm")],
            path: "MobileAgent",
            exclude: ["Info.plist", "MobileAgent.entitlements"],
            resources: [.copy("public")]
        ),
        .target(
            name: "PacketTunnel",
            path: "PacketTunnel",
            exclude: ["Info.plist", "PacketTunnel.entitlements"]
        ),
        .target(
            name: "ScreenBroadcast",
            path: "ScreenBroadcast",
            exclude: ["Info.plist", "ScreenBroadcast.entitlements"]
        ),
        .target(
            name: "ScreenBroadcastSetup",
            path: "ScreenBroadcastSetup",
            exclude: ["Info.plist", "ScreenBroadcastSetup.entitlements"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
