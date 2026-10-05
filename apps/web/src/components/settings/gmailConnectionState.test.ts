import type { GmailConnectionStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createGmailConnectionState } from "./gmailConnectionState";

const connected: GmailConnectionStatus = {
  configured: true,
  connected: true,
  email: "me@example.com",
};
const disconnected: GmailConnectionStatus = { configured: true, connected: false, email: null };

describe("shared Gmail connection state", () => {
  it("notifies both views of disconnect and shares one operation lock", async () => {
    const state = createGmailConnectionState();
    await state.refresh(async () => connected);
    const chat = vi.fn();
    const settings = vi.fn();
    state.subscribe(chat);
    state.subscribe(settings);
    const operation = state.beginOperation()!;
    expect(state.beginOperation()).toBeNull();
    state.setStatus(operation, disconnected);
    state.endOperation(operation);
    expect(state.getSnapshot()).toEqual({ status: disconnected, busy: false });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(settings).toHaveBeenCalledTimes(3);
  });

  it("does not restore a connection from a read started before disconnect", async () => {
    const state = createGmailConnectionState();
    let finish!: (status: GmailConnectionStatus) => void;
    const read = state.refresh(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = state.beginOperation()!;
    state.setStatus(operation, disconnected);
    state.endOperation(operation);
    finish(connected);
    await read;
    expect(state.getSnapshot().status).toEqual(disconnected);
  });

  it("ignores old sign-in results after a switch-off and allows a new operation", () => {
    const state = createGmailConnectionState();
    const signIn = state.beginOperation()!;
    state.cancelOperation(signIn);
    const disconnect = state.beginOperation()!;
    state.setStatus(disconnect, disconnected);
    state.setStatus(signIn, connected);
    state.endOperation(signIn);
    expect(state.getSnapshot()).toEqual({ status: disconnected, busy: true });
    state.endOperation(disconnect);
    expect(state.getSnapshot().busy).toBe(false);
  });

  it("refreshes the host status when returning to a view and keeps it during an outage", async () => {
    const state = createGmailConnectionState();
    await state.refresh(async () => connected);
    await state.refresh(async () => disconnected);
    await state.refresh(async () => {
      throw new Error("offline");
    });
    expect(state.getSnapshot().status).toEqual(disconnected);
  });
});
