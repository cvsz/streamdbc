package dev.zeaz.streamdbc.tv;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.rtsp.RtspMediaSource;
import androidx.media3.ui.PlayerView;

public final class RtspPlaybackController implements Player.Listener {
    public interface StatusListener {
        void onStatus(String status);
    }

    private static final long[] RETRY_DELAYS_MS = {1000, 2000, 5000, 10000, 30000};
    private final ExoPlayer player;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StatusListener listener;
    private StreamConfig current;
    private int retryIndex;
    private boolean released;

    public RtspPlaybackController(Context context, PlayerView view, StatusListener listener) {
        this.player = new ExoPlayer.Builder(context).build();
        this.listener = listener;
        this.player.addListener(this);
        view.setPlayer(player);
        view.setUseController(false);
    }

    public void play(StreamConfig channel) {
        current = channel;
        retryIndex = 0;
        startCurrent();
    }

    private void startCurrent() {
        if (released || current == null) return;
        handler.removeCallbacksAndMessages(null);
        RtspMediaSource source = new RtspMediaSource.Factory()
                .setForceUseRtpTcp(true)
                .createMediaSource(MediaItem.fromUri(current.url()));
        player.setMediaSource(source, true);
        player.prepare();
        player.play();
        listener.onStatus("Connecting · " + current.name());
    }

    @Override
    public void onPlaybackStateChanged(int state) {
        if (state == Player.STATE_READY) {
            retryIndex = 0;
            listener.onStatus("LIVE · " + current.name());
        } else if (state == Player.STATE_BUFFERING) {
            listener.onStatus("Buffering · " + (current == null ? "" : current.name()));
        } else if (state == Player.STATE_ENDED) {
            scheduleRetry("Stream ended");
        }
    }

    @Override
    public void onPlayerError(@NonNull PlaybackException error) {
        scheduleRetry("Playback error");
    }

    private void scheduleRetry(String reason) {
        if (released || current == null) return;
        int index = Math.min(retryIndex, RETRY_DELAYS_MS.length - 1);
        long delay = RETRY_DELAYS_MS[index];
        retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
        listener.onStatus(reason + " · retry in " + (delay / 1000) + "s");
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::startCurrent, delay);
    }

    public void retryNow() {
        retryIndex = 0;
        startCurrent();
    }

    public void release() {
        released = true;
        handler.removeCallbacksAndMessages(null);
        player.removeListener(this);
        player.release();
    }
}
