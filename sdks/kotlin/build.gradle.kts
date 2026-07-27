// Kotlin SDK（JVM）。機能範囲は他の言語と同一である（ADR-0018）。
plugins {
    kotlin("jvm") version "2.0.20"
}

group = "dev.wheso"
version = "0.0.0"

repositories {
    mavenCentral()
}

dependencies {
    // 試験でのみ使う。本体は依存を持たない（licensing.md）。
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
}

kotlin {
    explicitApi()
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
