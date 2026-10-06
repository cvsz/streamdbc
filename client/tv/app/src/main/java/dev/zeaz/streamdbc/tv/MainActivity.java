package dev.zeaz.streamdbc.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private final List<StreamConfig> channels = new ArrayList<>();
    private SecureStreamStore store;
    private RtspPlaybackController playback;
    private TextView title;
    private TextView status;
    private LinearLayout overlay;
    private int currentIndex;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        PlayerView playerView = new PlayerView(this);
        root.addView(playerView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        overlay = new LinearLayout(this);
        overlay.setOrientation(LinearLayout.VERTICAL);
        overlay.setPadding(32, 24, 32, 24);
        overlay.setBackgroundColor(0x99000000);

        title = text(24);
        status = text(16);
        overlay.addView(title);
        overlay.addView(status);

        FrameLayout.LayoutParams overlayParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        overlayParams.gravity = Gravity.TOP;
        root.addView(overlay, overlayParams);
        setContentView(root);

        store = new SecureStreamStore(this);
        try {
            channels.addAll(store.load());
        } catch (Exception e) {
            showToast(getString(R.string.secure_store_error));
        }

        playback = new RtspPlaybackController(this, playerView, value -> runOnUiThread(() -> status.setText(value)));

        if (channels.isEmpty()) {
            title.setText(getString(R.string.no_channel));
            status.setText(R.string.menu_manage_channels);
            overlay.setVisibility(View.VISIBLE);
        } else {
            playCurrent();
        }
    }

    private TextView text(int sp) {
        TextView view = new TextView(this);
        view.setTextColor(Color.WHITE);
        view.setTextSize(sp);
        view.setPadding(0, 4, 0, 4);
        return view;
    }

    private void playCurrent() {
        if (channels.isEmpty()) return;
        if (currentIndex >= channels.size()) currentIndex = 0;
        if (currentIndex < 0) currentIndex = channels.size() - 1;
        StreamConfig channel = channels.get(currentIndex);
        title.setText(getString(R.string.channel_position, channel.name(), currentIndex + 1, channels.size()));
        playback.play(channel);
    }

    private void switchBy(int delta) {
        if (channels.size() < 2) return;
        currentIndex = (currentIndex + delta + channels.size()) % channels.size();
        playCurrent();
    }

    private void manageChannels() {
        List<String> items = new ArrayList<>();
        items.add(getString(R.string.add_rtsp_channel));
        if (!channels.isEmpty()) items.add(getString(R.string.remove_current_channel));
        for (StreamConfig c : channels) items.add(getString(R.string.play_channel, c.name()));

        new AlertDialog.Builder(this)
                .setTitle(R.string.channels_title)
                .setItems(items.toArray(new String[0]), (dialog, which) -> {
                    if (which == 0) {
                        showAddDialog();
                        return;
                    }
                    int offset = 1;
                    if (!channels.isEmpty()) {
                        if (which == 1) {
                            removeCurrent();
                            return;
                        }
                        offset = 2;
                    }
                    int index = which - offset;
                    if (index >= 0 && index < channels.size()) {
                        currentIndex = index;
                        playCurrent();
                    }
                })
                .show();
    }

    private void showAddDialog() {
        LinearLayout form = new LinearLayout(this);
        form.setPadding(32, 12, 32, 0);
        form.setOrientation(LinearLayout.VERTICAL);

        EditText name = new EditText(this);
        name.setHint(R.string.channel_name_hint);
        name.setSingleLine(true);

        EditText url = new EditText(this);
        url.setHint(R.string.rtsp_url_hint);
        url.setSingleLine(true);

        form.addView(name);
        form.addView(url);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.add_rtsp_channel)
                .setView(form)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.save, null)
                .create();

        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                StreamConfig config = new StreamConfig(name.getText().toString(), url.getText().toString());
                channels.add(config);
                store.save(channels);
                currentIndex = channels.size() - 1;
                dialog.dismiss();
                playCurrent();
            } catch (Exception e) {
                showToast(e.getMessage() == null ? getString(R.string.unable_save_channel) : e.getMessage());
            }
        }));
        dialog.show();
    }

    private void removeCurrent() {
        if (channels.isEmpty()) return;
        StreamConfig current = channels.get(currentIndex);
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.remove_channel_title, current.name()))
                .setMessage(R.string.remove_channel_message)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.remove, (d, w) -> {
                    channels.remove(currentIndex);
                    if (currentIndex >= channels.size()) currentIndex = Math.max(0, channels.size() - 1);
                    try {
                        store.save(channels);
                    } catch (Exception e) {
                        showToast(getString(R.string.persist_delete_error));
                    }
                    if (channels.isEmpty()) {
                        title.setText(getString(R.string.no_channel));
                        status.setText(R.string.menu_manage_channels);
                    } else {
                        playCurrent();
                    }
                })
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (event.getRepeatCount() > 0) return super.onKeyDown(keyCode, event);
        if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
            switchBy(-1);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_RIGHT || keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            switchBy(1);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            manageChannels();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) {
            overlay.setVisibility(overlay.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) {
            playback.retryNow();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void showToast(String value) {
        Toast.makeText(this, value, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onDestroy() {
        playback.release();
        super.onDestroy();
    }
}
