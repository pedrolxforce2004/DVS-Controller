package br.com.decode.dvsreceiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent == null ? "" : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)) return;
        SharedPreferences prefs = context.getSharedPreferences("dvs", Context.MODE_PRIVATE);
        if (!prefs.getBoolean("autoLaunch", false)) return;
        Intent start = new Intent(context, MainActivity.class);
        start.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(start);
    }
}
