// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TokenomicsMenubar",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "TokenomicsMenubar", targets: ["TokenomicsMenubar"]),
    ],
    targets: [
        .executableTarget(
            name: "TokenomicsMenubar"
        ),
        .testTarget(
            name: "TokenomicsMenubarTests",
            dependencies: ["TokenomicsMenubar"]
        ),
    ]
)
