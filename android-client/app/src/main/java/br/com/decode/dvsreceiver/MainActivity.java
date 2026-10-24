package br.com.decode.dvsreceiver;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final int BG = Color.rgb(8, 15, 27);
    private static final int PANEL = Color.rgb(16, 27, 47);
    private static final int PANEL_SOFT = Color.rgb(22, 34, 56);
    private static final int STROKE = Color.rgb(36, 54, 82);
    private static final int STROKE_FOCUS = Color.rgb(49, 211, 196);
    private static final int TEXT = Color.rgb(244, 248, 255);
    private static final int MUTED = Color.rgb(154, 178, 213);
    private static final int ACCENT = Color.rgb(49, 211, 196);
    private static final int DANGER = Color.rgb(255, 109, 128);

    private WebView web;
    private SharedPreferences prefs;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String receiverUrl = "";
    private boolean configuring = false;
    private long lastPageFinishedAt = 0;
    private final Runnable retry = () -> { if (!configuring && web != null) web.loadUrl(receiverUrl); };
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (!configuring && web != null) {
                long idleMs = System.currentTimeMillis() - lastPageFinishedAt;
                if (lastPageFinishedAt == 0 || idleMs > 180000) {
                    web.post(() -> {
                        try { web.evaluateJavascript("document.body && document.body.innerText || ''", value -> {
                            if (value == null || value.length() < 8 || value.contains("Problema no Link do Painel")) web.reload();
                        }); } catch (Exception ignored) { web.reload(); }
                    });
                    lastPageFinishedAt = System.currentTimeMillis();
                }
            }
            handler.postDelayed(this, 60000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        prefs = getSharedPreferences("dvs", MODE_PRIVATE);
        if (prefs.getString("server", "").isEmpty()) configure(); else connect();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable background(int color, int strokeColor, int strokeWidth, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(strokeWidth), strokeColor);
        return drawable;
    }

    private TextView text(String value, float size, int color, int style) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        view.setIncludeFontPadding(true);
        return view;
    }

    private TextView label(String value) {
        TextView view = text(value, 14, MUTED, Typeface.BOLD);
        view.setPadding(0, dp(14), 0, dp(5));
        return view;
    }

    private EditText field(String hint, String value) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(value);
        input.setHint(hint);
        input.setTextSize(20);
        input.setTextColor(TEXT);
        input.setHintTextColor(Color.rgb(96, 117, 148));
        input.setPadding(dp(18), 0, dp(18), 0);
        input.setSelectAllOnFocus(false);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        input.setLayoutParams(params);
        focusBackground(input, PANEL_SOFT);
        return input;
    }

    private void focusBackground(View view, int color) {
        view.setBackground(background(color, STROKE, 1, 8));
        view.setOnFocusChangeListener((target, hasFocus) -> target.setBackground(background(color, hasFocus ? STROKE_FOCUS : STROKE, hasFocus ? 2 : 1, 8)));
    }

    private Button primaryButton(String title) {
        Button button = new Button(this);
        button.setText(title);
        button.setTextSize(18);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setTextColor(Color.rgb(3, 24, 30));
        button.setAllCaps(false);
        button.setPadding(dp(20), 0, dp(20), 0);
        button.setBackground(background(ACCENT, ACCENT, 1, 8));
        button.setOnFocusChangeListener((target, hasFocus) -> target.setBackground(background(hasFocus ? Color.rgb(105, 240, 228) : ACCENT, Color.WHITE, hasFocus ? 2 : 1, 8)));
        button.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)));
        return button;
    }

    private TextView brandBadge() {
        TextView badge = text("DVS", 16, Color.WHITE, Typeface.BOLD);
        badge.setGravity(Gravity.CENTER);
        badge.setBackground(background(Color.rgb(35, 128, 242), Color.rgb(35, 128, 242), 1, 10));
        badge.setLayoutParams(new LinearLayout.LayoutParams(dp(62), dp(62)));
        return badge;
    }

    private LinearLayout panel() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(34), dp(30), dp(34), dp(32));
        card.setBackground(background(PANEL, STROKE, 1, 16));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(780), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        params.setMargins(dp(32), dp(32), dp(32), dp(32));
        card.setLayoutParams(params);
        return card;
    }

    private FrameLayout shell(View content) {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        root.addView(content);
        return root;
    }

    private void disposeWeb() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
    }

    private void configure() {
        configuring = true;
        disposeWeb();

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setPadding(dp(28), dp(20), dp(28), dp(20));
        LinearLayout card = panel();

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(brandBadge());

        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        titleBox.setPadding(dp(18), 0, 0, 0);
        titleBox.addView(text("DVS Receiver", 30, TEXT, Typeface.BOLD));
        titleBox.addView(text("Android TV - versao 0.6.9", 16, MUTED, Typeface.NORMAL));
        header.addView(titleBox, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        card.addView(header);

        TextView help = text("Configure a TV para conectar ao servidor DVS Controller. Use HTTPS em producao; HTTP deve ficar restrito a redes internas controladas.", 16, MUTED, Typeface.NORMAL);
        help.setPadding(0, dp(24), 0, dp(4));
        card.addView(help);

        card.addView(label("Servidor"));
        EditText server = field("https://servidor-dvs:3080", prefs.getString("server", ""));
        card.addView(server);

        card.addView(label("Nome da TV"));
        EditText name = field("Recepcao - Android TV", prefs.getString("name", "Android TV"));
        card.addView(name);

        CheckBox http = new CheckBox(this);
        http.setText("Permitir HTTP nesta rede");
        http.setTextSize(16);
        http.setTextColor(TEXT);
        http.setPadding(0, dp(16), 0, dp(12));
        http.setChecked(prefs.getBoolean("http", false));
        focusBackground(http, PANEL);
        card.addView(http, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)));

        TextView status = text("Pronto para conectar", 15, MUTED, Typeface.BOLD);
        status.setPadding(0, 0, 0, dp(12));
        card.addView(status);

        Button save = primaryButton("Conectar ao painel");
        card.addView(save);
        save.setOnClickListener(v -> {
            String value = server.getText().toString().trim().replaceAll("/+$", "");
            Uri uri = Uri.parse(value);
            boolean valid = "https".equals(uri.getScheme()) || (http.isChecked() && "http".equals(uri.getScheme()));
            if (!valid || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty()) || name.getText().toString().trim().isEmpty()) {
                status.setTextColor(DANGER);
                status.setText("Informe a origem do servidor e um nome para esta TV.");
                server.setError("Use somente a origem do servidor, sem caminho. HTTPS recomendado.");
                return;
            }
            status.setTextColor(ACCENT);
            status.setText("Conectando...");
            prefs.edit().putString("server", value).putString("name", name.getText().toString().trim()).putBoolean("http", http.isChecked()).apply();
            connect();
        });

        scroll.addView(card);
        setContentView(shell(scroll));
        server.requestFocus();
    }

    private boolean trusted(String raw) {
        Uri a = Uri.parse(prefs.getString("server", "")), b = Uri.parse(raw);
        return a.getScheme() != null && a.getScheme().equals(b.getScheme()) && a.getHost() != null && a.getHost().equals(b.getHost()) && a.getPort() == b.getPort();
    }

    private void connect() {
        configuring = false;
        disposeWeb();
        receiverUrl = prefs.getString("server", "") + "/tv-app?name=" + Uri.encode(prefs.getString("name", "Android TV")) + "&platform=Android%20TV&launcherVersion=0.6.9";
        lastPageFinishedAt = System.currentTimeMillis();
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String scheme = request.getUrl().getScheme();
                return !("https".equals(scheme) || (prefs.getBoolean("http", false) && "http".equals(scheme))) || (request.isForMainFrame() && !trusted(request.getUrl().toString()));
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { failed(request); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) { failed(request); }
            @Override public void onPageFinished(WebView view, String url) { lastPageFinishedAt = System.currentTimeMillis(); CookieManager.getInstance().flush(); }
        });
        setContentView(web);
        web.loadUrl(receiverUrl);
        web.requestFocus();
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, 60000);
    }

    private void failed(WebResourceRequest request) {
        if (request.isForMainFrame()) {
            showLinkError();
            handler.removeCallbacks(retry);
            handler.postDelayed(() -> { if (!configuring && web != null) { setContentView(web); retry.run(); } }, 15000);
        } else if (web != null && trusted(web.getUrl() == null ? "" : web.getUrl())) {
            web.evaluateJavascript("(function(){var f=document.getElementById('frame');if(f&&f.src===" + JSONObject.quote(request.getUrl().toString()) + "){f.dispatchEvent(new Event('error'));}})()", null);
        }
    }

    private void showLinkError() {
        LinearLayout card = panel();
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(brandBadge());
        LinearLayout titleBox = new LinearLayout(this);
        titleBox.setOrientation(LinearLayout.VERTICAL);
        titleBox.setPadding(dp(18), 0, 0, 0);
        titleBox.addView(text("Problema no Link do Painel", 30, TEXT, Typeface.BOLD));
        titleBox.addView(text("DVS Receiver - Android TV", 16, MUTED, Typeface.NORMAL));
        header.addView(titleBox, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        card.addView(header);

        TextView message = text("Nao foi possivel carregar o painel configurado. O DVS Receiver tentara novamente em 15 segundos.", 19, MUTED, Typeface.NORMAL);
        message.setPadding(0, dp(28), 0, dp(12));
        card.addView(message);

        TextView hint = text("Pressione Voltar e escolha Configurar servidor para corrigir o endereco.", 17, TEXT, Typeface.BOLD);
        hint.setBackground(background(PANEL_SOFT, STROKE, 1, 8));
        hint.setPadding(dp(18), dp(16), dp(18), dp(16));
        card.addView(hint);
        setContentView(shell(card));
    }

    @Override public void onBackPressed() {
        if (configuring) { super.onBackPressed(); return; }
        new AlertDialog.Builder(this).setTitle("DVS Receiver").setItems(new String[]{"Voltar ao painel", "Recarregar", "Configurar servidor"}, (dialog, item) -> { if (item == 1) connect(); if (item == 2) configure(); }).show();
    }

    @Override protected void onDestroy() { handler.removeCallbacks(watchdog); disposeWeb(); super.onDestroy(); }
}
