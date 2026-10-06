package dev.zeaz.streamdbc.tv

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

private const val DEFAULT_RTSP_URL = "rtsp://192.168.1.100:554/stream1"
private val RETRY_DELAYS_MS = listOf(1_000L, 2_000L, 5_000L, 10_000L, 30_000L)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = Color.Black) {
                    RtspTvScreen()
                }
            }
        }
    }
}

@Composable
private fun RtspTvScreen() {
    val context = LocalContext.current
    var rtspUrl by remember { mutableStateOf(DEFAULT_RTSP_URL) }
    var activeUrl by remember { mutableStateOf(DEFAULT_RTSP_URL) }
    var status by remember { mutableStateOf("Idle") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var retryAttempt by remember { mutableIntStateOf(0) }
    var reconnectNonce by remember { mutableIntStateOf(0) }

    val player = remember {
        ExoPlayer.Builder(context).build().apply { playWhenReady = true }
    }

    fun play(url: String, resetRetry: Boolean = true) {
        if (!url.startsWith("rtsp://") && !url.startsWith("rtsps://")) {
            errorMessage = "Only rtsp:// or rtsps:// URLs are accepted."
            status = "Invalid URL"
            return
        }

        val source = RtspMediaSource.Factory()
            .setForceUseRtpTcp(true)
            .createMediaSource(MediaItem.fromUri(url))

        errorMessage = null
        status = "Connecting"
        if (resetRetry) retryAttempt = 0
        activeUrl = url
        player.setMediaSource(source)
        player.prepare()
        player.play()
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                status = when (playbackState) {
                    Player.STATE_BUFFERING -> "Buffering"
                    Player.STATE_READY -> "LIVE"
                    Player.STATE_ENDED -> "Ended"
                    else -> status
                }
                if (playbackState == Player.STATE_READY) {
                    retryAttempt = 0
                    errorMessage = null
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                status = "Stream unavailable"
                errorMessage = error.errorCodeName
                reconnectNonce += 1
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    LaunchedEffect(reconnectNonce) {
        if (reconnectNonce == 0 || activeUrl.isBlank()) return@LaunchedEffect
        val index = retryAttempt.coerceAtMost(RETRY_DELAYS_MS.lastIndex)
        delay(RETRY_DELAYS_MS[index])
        retryAttempt = (retryAttempt + 1).coerceAtMost(RETRY_DELAYS_MS.lastIndex)
        status = "Reconnecting"
        play(activeUrl, resetRetry = false)
    }

    LaunchedEffect(Unit) { play(activeUrl) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onPreviewKeyEvent { event ->
                val nativeEvent = event.nativeKeyEvent
                if (nativeEvent.action != KeyEvent.ACTION_DOWN) return@onPreviewKeyEvent false
                when (nativeEvent.keyCode) {
                    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                    KeyEvent.KEYCODE_DPAD_CENTER,
                    KeyEvent.KEYCODE_ENTER -> {
                        if (player.isPlaying) player.pause() else player.play()
                        true
                    }
                    else -> false
                }
            }
            .focusable()
    ) {
        Box(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentAlignment = Alignment.Center
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = false
                        this.player = player
                        keepScreenOn = true
                    }
                },
                update = { it.player = player }
            )

            Text(
                text = status,
                color = if (status == "LIVE") Color.Green else Color.White,
                modifier = Modifier.align(Alignment.TopStart).padding(16.dp)
            )

            errorMessage?.let {
                Text(
                    text = it + " · retry " + (retryAttempt + 1),
                    color = Color.White,
                    modifier = Modifier
                        .align(Alignment.Center)
                        .background(Color(0x99000000))
                        .padding(16.dp)
                )
            }
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0xFF111827))
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            OutlinedTextField(
                value = rtspUrl,
                onValueChange = { rtspUrl = it.trim() },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("RTSP URL") }
            )
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { play(rtspUrl) }) { Text("Play") }
                Button(onClick = {
                    player.stop()
                    reconnectNonce += 1
                }) { Text("Reconnect") }
                Button(onClick = {
                    if (player.isPlaying) player.pause() else player.play()
                }) { Text(if (player.isPlaying) "Pause" else "Play") }
            }
        }
    }
}
