// Argus for Android: the globe, its proxy (Node, on the phone) and the Android
// Auto map, in one installable app. See docs/ANDROID.md.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "argus-android"
include(":app")
