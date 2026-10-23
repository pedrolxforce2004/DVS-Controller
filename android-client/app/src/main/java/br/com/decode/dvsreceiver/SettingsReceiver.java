package br.com.decode.dvsreceiver;

import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

public class SettingsReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !"br.com.decode.dvsreceiver.SET_AUTO_LAUNCH".equals(intent.getAction())) return;
        boolean enabled = intent.getBooleanExtra("enabled", false);
        SharedPreferences prefs = context.getSharedPreferences("dvs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit().putBoolean("autoLaunch", enabled);
        if (intent.hasExtra("server")) editor.putString("server", intent.getStringExtra("server"));
        if (intent.hasExtra("name")) editor.putString("name", intent.getStringExtra("name"));
        if (intent.hasExtra("http")) editor.putBoolean("http", intent.getBooleanExtra("http", false));
        editor.apply();
        ComponentName receiver = new ComponentName(context, BootReceiver.class);
        context.getPackageManager().setComponentEnabledSetting(
            receiver,
            enabled ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP
        );
    }
}
