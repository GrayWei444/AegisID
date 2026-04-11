package com.aegisrd.touchtest;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeTouchPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
