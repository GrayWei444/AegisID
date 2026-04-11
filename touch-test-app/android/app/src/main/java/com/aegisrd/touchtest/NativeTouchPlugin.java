package com.aegisrd.touchtest;

import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "NativeTouch")
public class NativeTouchPlugin extends Plugin {

    private boolean capturing = false;
    private final List<JSONObject> touchEvents = new ArrayList<>();

    @PluginMethod
    public void startCapture(PluginCall call) {
        boolean includeMove = Boolean.TRUE.equals(call.getBoolean("includeMove", false));
        capturing = true;
        touchEvents.clear();

        getActivity().runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            webView.setOnTouchListener((View v, MotionEvent event) -> {
                if (!capturing) return false;

                try {
                    int action = event.getActionMasked();
                    boolean capture = (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_UP);
                    if (includeMove && action == MotionEvent.ACTION_MOVE) {
                        capture = true;
                    }

                    if (capture) {
                        // First, add any batched historical samples (MOVE only)
                        if (action == MotionEvent.ACTION_MOVE) {
                            int histSize = event.getHistorySize();
                            for (int h = 0; h < histSize; h++) {
                                JSONObject hObj = new JSONObject();
                                hObj.put("action", "move");
                                hObj.put("timestamp", event.getHistoricalEventTime(h));
                                hObj.put("x", event.getHistoricalX(h));
                                hObj.put("y", event.getHistoricalY(h));
                                hObj.put("pressure", event.getHistoricalPressure(h));
                                hObj.put("size", event.getHistoricalSize(h));
                                hObj.put("touchMajor", event.getHistoricalTouchMajor(h));
                                hObj.put("touchMinor", event.getHistoricalTouchMinor(h));
                                hObj.put("toolMajor", event.getHistoricalToolMajor(h));
                                hObj.put("toolMinor", event.getHistoricalToolMinor(h));
                                hObj.put("orientation", event.getHistoricalOrientation(h));
                                touchEvents.add(hObj);
                            }
                        }

                        // Current sample
                        JSONObject obj = new JSONObject();
                        String actionStr = "move";
                        if (action == MotionEvent.ACTION_DOWN) actionStr = "down";
                        else if (action == MotionEvent.ACTION_UP) actionStr = "up";
                        obj.put("action", actionStr);
                        obj.put("timestamp", event.getEventTime());
                        obj.put("x", event.getX());
                        obj.put("y", event.getY());
                        obj.put("rawX", event.getRawX());
                        obj.put("rawY", event.getRawY());
                        obj.put("pressure", event.getPressure());
                        obj.put("size", event.getSize());
                        obj.put("touchMajor", event.getTouchMajor());
                        obj.put("touchMinor", event.getTouchMinor());
                        obj.put("toolMajor", event.getToolMajor());
                        obj.put("toolMinor", event.getToolMinor());
                        obj.put("orientation", event.getOrientation());
                        obj.put("toolType", event.getToolType(0));
                        obj.put("eventTime", event.getEventTime());
                        obj.put("downTime", event.getDownTime());

                        touchEvents.add(obj);
                    }
                } catch (Exception e) {
                    // ignore
                }
                return false;
            });
        });

        call.resolve(new JSObject().put("status", "capturing"));
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        capturing = false;

        getActivity().runOnUiThread(() -> {
            getBridge().getWebView().setOnTouchListener(null);
        });

        JSObject result = new JSObject();
        JSONArray arr = new JSONArray(touchEvents);
        result.put("events", arr);
        result.put("count", touchEvents.size());
        touchEvents.clear();

        call.resolve(result);
    }

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("manufacturer", android.os.Build.MANUFACTURER);
        result.put("model", android.os.Build.MODEL);
        result.put("sdkVersion", android.os.Build.VERSION.SDK_INT);
        result.put("release", android.os.Build.VERSION.RELEASE);

        android.util.DisplayMetrics dm = getActivity().getResources().getDisplayMetrics();
        result.put("screenWidth", dm.widthPixels);
        result.put("screenHeight", dm.heightPixels);
        result.put("density", dm.density);
        result.put("densityDpi", dm.densityDpi);

        call.resolve(result);
    }
}
