plugins {
    id("com.android.application")
}

android {
    namespace = "dev.zeaz.streamdbc.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.zeaz.streamdbc.tv"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        warningsAsErrors = true
    }
}

dependencies {
    implementation("androidx.annotation:annotation:1.10.0")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-rtsp:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    testImplementation("junit:junit:4.13.2")
}
