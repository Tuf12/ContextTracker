import crypto from "crypto";
import * as vscode from "vscode";

export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: "sidebar" | "editor"): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${style}" />
  <title>Context Tracker</title>
</head>
<body data-surface="${surface}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
