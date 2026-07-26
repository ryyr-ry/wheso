plugins {
    kotlin("jvm") version "2.0.20"
}

group = "dev.wheso"
version = "0.0.0"

kotlin {
    explicitApi()
    compilerOptions { freeCompilerArgs.add("-Xjvm-default=all") }
}
