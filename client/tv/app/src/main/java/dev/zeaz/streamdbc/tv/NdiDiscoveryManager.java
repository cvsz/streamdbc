package dev.zeaz.streamdbc.tv;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class NdiDiscoveryManager {
    private static final String SERVICE_TYPE = "_ndi._tcp.";
    private final NsdManager nsdManager;
    private final List<String> sources = Collections.synchronizedList(new ArrayList<>());
    private NsdManager.DiscoveryListener listener;

    public NdiDiscoveryManager(Context context) {
        nsdManager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
    }

    public synchronized void start() {
        if (listener != null) return;
        sources.clear();
        listener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String serviceType) {}
            @Override public void onDiscoveryStopped(String serviceType) {}
            @Override public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (!SERVICE_TYPE.equals(serviceInfo.getServiceType())) return;
                String name = serviceInfo.getServiceName();
                if (name != null && !name.isBlank() && !sources.contains(name)) {
                    sources.add(name);
                }
            }
            @Override public void onServiceLost(NsdServiceInfo serviceInfo) {
                String name = serviceInfo.getServiceName();
                if (name != null) sources.remove(name);
            }
            @Override public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                stop();
            }
            @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                listener = null;
            }
        };
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
    }

    public synchronized void stop() {
        NsdManager.DiscoveryListener current = listener;
        listener = null;
        if (current == null) return;
        try {
            nsdManager.stopServiceDiscovery(current);
        } catch (IllegalArgumentException ignored) {
            // Discovery may already have been stopped by the platform.
        }
    }

    public List<String> snapshot() {
        synchronized (sources) {
            List<String> copy = new ArrayList<>(sources);
            Collections.sort(copy);
            return copy;
        }
    }
}
