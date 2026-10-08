import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Two inputs are staged before Gradle runs (both gitignored):
//   src/main/assets/nodejs-project/  the built globe + proxy + its runtime deps
//                                    (node scripts/android-bundle.mjs)
//   libnode/                         nodejs-mobile's libnode.so per ABI and its
//                                    headers (android/fetch-libnode.sh)
// The phone build is arm64 only by default (the S25 and every current phone);
// add more with -PargusAbis=arm64-v8a,x86_64 (x86_64 for the emulator).
val argusAbis: List<String> =
    ((findProperty("argusAbis") as String?) ?: "arm64-v8a")
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }

// Release signing from the environment (CI decodes the repository secrets into
// a temporary keystore). Without it the release APK is signed with the debug
// key so it still installs; see docs/ANDROID.md.
val releaseKeystore: String? =
    System.getenv("ARGUS_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && file(it).isFile }

android {
    namespace = "net.h4ch1.argus"
    compileSdk = 35
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "net.h4ch1.argus"
        minSdk = 26
        targetSdk = 35
        versionCode = (findProperty("argusVersionCode") as String?)?.toIntOrNull() ?: 1
        versionName = (findProperty("argusVersionName") as String?) ?: "0.1.0"

        ndk { abiFilters += argusAbis }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                // libnode.so is linked against the shared C++ runtime.
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDir("libnode/bin")
        }
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("ARGUS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ARGUS_KEY_ALIAS")
                keyPassword = System.getenv("ARGUS_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig =
                signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // aapt's default pattern drops files starting with "." and folders
        // starting with "_", which a Node project may contain. Package them all.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }

    packaging {
        // Compressed in the APK (a smaller download from the release page),
        // extracted at install.
        jniLibs { useLegacyPackaging = true }
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.car.app:app:1.4.0")
}

// Fail early with a clear message when a staged input is missing, instead of an
// APK that starts without its proxy.
val checkArgusInputs by tasks.registering {
    val manifest = file("src/main/assets/nodejs-project/argus-manifest.json")
    val header = file("libnode/include/node/node.h")
    val libs = argusAbis.map { file("libnode/bin/$it/libnode.so") }
    doLast {
        val missing = mutableListOf<String>()
        if (!manifest.isFile) {
            missing += "$manifest (run: npm run build && node scripts/android-bundle.mjs)"
        }
        if (!header.isFile) missing += "$header (run: android/fetch-libnode.sh)"
        libs.filterNot { it.isFile }.forEach { missing += "$it (run: android/fetch-libnode.sh)" }
        if (missing.isNotEmpty()) {
            throw GradleException("Argus build inputs missing:\n  " + missing.joinToString("\n  "))
        }
    }
}
tasks.named("preBuild") { dependsOn(checkArgusInputs) }
