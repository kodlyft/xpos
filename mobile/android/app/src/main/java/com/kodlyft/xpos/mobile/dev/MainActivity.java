package com.kodlyft.xpos.mobile.dev;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.kodlyft.xpos.mobile.plugin.XposNativePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(XposNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
