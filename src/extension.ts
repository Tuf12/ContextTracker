import * as vscode from "vscode";
import { TrackerApp } from "./app";

let app: TrackerApp | undefined;

export function activate(context: vscode.ExtensionContext): void {
  app = new TrackerApp(context);
  context.subscriptions.push({ dispose: () => app?.dispose() });
  app.start();
}

export function deactivate(): void {
  app?.dispose();
  app = undefined;
}
