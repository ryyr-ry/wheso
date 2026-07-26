// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "WhesoClient",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "WhesoClient", targets: ["WhesoClient"])],
    targets: [
        .target(name: "WhesoClient"),
        .testTarget(name: "WhesoClientTests", dependencies: ["WhesoClient"]),
    ]
)
