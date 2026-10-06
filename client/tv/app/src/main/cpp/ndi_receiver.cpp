#include <jni.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef STREAMDBC_NDI_SDK
#include "Processing.NDI.Lib.h"
#endif

namespace {
std::mutex g_mutex;
std::thread g_thread;
std::atomic<bool> g_running{false};
ANativeWindow* g_window = nullptr;

void stop_locked() {
    g_running.store(false);
    if (g_thread.joinable()) {
        g_thread.join();
    }
    if (g_window != nullptr) {
        ANativeWindow_release(g_window);
        g_window = nullptr;
    }
}

#ifdef STREAMDBC_NDI_SDK
std::vector<std::string> discover_sources(uint32_t wait_ms) {
    std::vector<std::string> result;
    NDIlib_find_create_t find_desc{};
    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&find_desc);
    if (finder == nullptr) return result;

    NDIlib_find_wait_for_sources(finder, wait_ms);
    uint32_t count = 0;
    const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &count);
    result.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        if (sources[i].p_ndi_name != nullptr && sources[i].p_ndi_name[0] != '\0') {
            result.emplace_back(sources[i].p_ndi_name);
        }
    }
    NDIlib_find_destroy(finder);
    return result;
}

bool resolve_source(const std::string& wanted, NDIlib_source_t& out) {
    NDIlib_find_create_t find_desc{};
    NDIlib_find_instance_t finder = NDIlib_find_create_v2(&find_desc);
    if (finder == nullptr) return false;

    bool found = false;
    for (int attempt = 0; attempt < 6 && g_running.load() && !found; ++attempt) {
        NDIlib_find_wait_for_sources(finder, 500);
        uint32_t count = 0;
        const NDIlib_source_t* sources = NDIlib_find_get_current_sources(finder, &count);
        for (uint32_t i = 0; i < count; ++i) {
            const char* name = sources[i].p_ndi_name;
            if (name != nullptr && wanted == name) {
                out = sources[i];
                found = true;
                break;
            }
        }
    }

    if (!found) {
        NDIlib_find_destroy(finder);
        return false;
    }

    std::string name_copy = out.p_ndi_name == nullptr ? "" : out.p_ndi_name;
    std::string url_copy = out.p_url_address == nullptr ? "" : out.p_url_address;
    NDIlib_find_destroy(finder);

    static thread_local std::string source_name;
    static thread_local std::string source_url;
    source_name = std::move(name_copy);
    source_url = std::move(url_copy);
    out.p_ndi_name = source_name.c_str();
    out.p_url_address = source_url.empty() ? nullptr : source_url.c_str();
    return true;
}

void render_rgba(const NDIlib_video_frame_v2_t& frame) {
    if (g_window == nullptr || frame.p_data == nullptr || frame.xres <= 0 || frame.yres <= 0) return;

    ANativeWindow_setBuffersGeometry(g_window, frame.xres, frame.yres, WINDOW_FORMAT_RGBA_8888);
    ANativeWindow_Buffer buffer{};
    if (ANativeWindow_lock(g_window, &buffer, nullptr) != 0) return;

    const int src_stride = frame.line_stride_in_bytes;
    const int dst_stride = buffer.stride * 4;
    const int row_bytes = frame.xres * 4;
    auto* dst = static_cast<uint8_t*>(buffer.bits);
    const auto* src = static_cast<const uint8_t*>(frame.p_data);

    for (int y = 0; y < frame.yres; ++y) {
        std::memcpy(dst + y * dst_stride, src + y * src_stride, row_bytes);
    }
    ANativeWindow_unlockAndPost(g_window);
}

void receive_loop(std::string source_name) {
    while (g_running.load()) {
        NDIlib_source_t source{};
        if (!resolve_source(source_name, source)) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            continue;
        }

        NDIlib_recv_create_v3_t recv_desc{};
        recv_desc.source_to_connect_to = source;
        recv_desc.color_format = NDIlib_recv_color_format_RGBX_RGBA;
        recv_desc.bandwidth = NDIlib_recv_bandwidth_highest;
        recv_desc.allow_video_fields = false;
        recv_desc.p_ndi_recv_name = "StreamDBC TV";

        NDIlib_recv_instance_t receiver = NDIlib_recv_create_v3(&recv_desc);
        if (receiver == nullptr) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            continue;
        }

        int empty_frames = 0;
        while (g_running.load()) {
            NDIlib_video_frame_v2_t video{};
            NDIlib_audio_frame_v3_t audio{};
            NDIlib_metadata_frame_t metadata{};
            const NDIlib_frame_type_e type =
                    NDIlib_recv_capture_v3(receiver, &video, &audio, &metadata, 1000);

            if (type == NDIlib_frame_type_video) {
                empty_frames = 0;
                render_rgba(video);
                NDIlib_recv_free_video_v2(receiver, &video);
            } else if (type == NDIlib_frame_type_audio) {
                NDIlib_recv_free_audio_v3(receiver, &audio);
            } else if (type == NDIlib_frame_type_metadata) {
                NDIlib_recv_free_metadata(receiver, &metadata);
            } else {
                ++empty_frames;
                if (empty_frames >= 5) break;
            }
        }
        NDIlib_recv_destroy(receiver);
    }
}
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_dev_zeaz_streamdbc_tv_NdiReceiver_nativeIsAvailable(JNIEnv*, jclass) {
#ifdef STREAMDBC_NDI_SDK
    return NDIlib_initialize() ? JNI_TRUE : JNI_FALSE;
#else
    return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT jobjectArray JNICALL
Java_dev_zeaz_streamdbc_tv_NdiReceiver_nativeListSources(JNIEnv* env, jclass) {
    jclass string_class = env->FindClass("java/lang/String");
#ifdef STREAMDBC_NDI_SDK
    if (!NDIlib_initialize()) return env->NewObjectArray(0, string_class, nullptr);
    const auto sources = discover_sources(1200);
    jobjectArray array = env->NewObjectArray(static_cast<jsize>(sources.size()), string_class, nullptr);
    for (jsize i = 0; i < static_cast<jsize>(sources.size()); ++i) {
        env->SetObjectArrayElement(array, i, env->NewStringUTF(sources[i].c_str()));
    }
    return array;
#else
    return env->NewObjectArray(0, string_class, nullptr);
#endif
}

extern "C" JNIEXPORT jboolean JNICALL
Java_dev_zeaz_streamdbc_tv_NdiReceiver_nativeStart(
        JNIEnv* env, jclass, jstring source_name, jobject surface) {
#ifdef STREAMDBC_NDI_SDK
    if (!NDIlib_initialize() || source_name == nullptr || surface == nullptr) return JNI_FALSE;

    const char* chars = env->GetStringUTFChars(source_name, nullptr);
    if (chars == nullptr) return JNI_FALSE;
    std::string name(chars);
    env->ReleaseStringUTFChars(source_name, chars);

    std::lock_guard<std::mutex> lock(g_mutex);
    stop_locked();
    g_window = ANativeWindow_fromSurface(env, surface);
    if (g_window == nullptr) return JNI_FALSE;
    g_running.store(true);
    g_thread = std::thread(receive_loop, std::move(name));
    return JNI_TRUE;
#else
    (void)env;
    (void)source_name;
    (void)surface;
    return JNI_FALSE;
#endif
}

extern "C" JNIEXPORT void JNICALL
Java_dev_zeaz_streamdbc_tv_NdiReceiver_nativeStop(JNIEnv*, jclass) {
    std::lock_guard<std::mutex> lock(g_mutex);
    stop_locked();
}
