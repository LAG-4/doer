import type { GmailConnectionStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createGmailConnectionState, resolveGmailHostAccess } from "./gmailConnectionState";

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

describe("Gmail host access", () => {
  const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  it("treats the primary local target over loopback as the host", () => {
    expect(
      resolveGmailHostAccess({
        httpBaseUrl: "http://127.0.0.1:43123/",
        targetTag: "PrimaryConnectionTarget",
        computerLabel: "Office",
        isLoopback,
      }),
    ).toEqual({ reachable: true, onHost: true, guidance: null });
    expect(
      resolveGmailHostAccess({
        httpBaseUrl: null,
        targetTag: "PrimaryConnectionTarget",
        computerLabel: "Office",
        isLoopback,
      }),
    ).toEqual({ reachable: false, onHost: false, guidance: null });
    expect(
      resolveGmailHostAccess({
        httpBaseUrl: "not a url",
        targetTag: "PrimaryConnectionTarget",
        computerLabel: "Office",
        isLoopback,
      }),
    ).toEqual({ reachable: false, onHost: false, guidance: null });
  });

  it("never treats a loopback URL over SSH or relay transport as the host", () => {
    // An SSH tunnel serves a remote computer over localhost: the OAuth
    // callback would finish on the remote host, not in this browser.
    for (const targetTag of [
      "SshConnectionTarget",
      "RelayConnectionTarget",
      "BearerConnectionTarget",
    ]) {
      const forwarded = resolveGmailHostAccess({
        httpBaseUrl: "http://127.0.0.1:43123/",
        targetTag,
        computerLabel: "Office",
        isLoopback,
      });
      expect(forwarded.reachable).toBe(true);
      expect(forwarded.onHost).toBe(false);
      expect(forwarded.guidance).toContain("Office");
    }
    // A non-loopback primary route is not the host either.
    expect(
      resolveGmailHostAccess({
        httpBaseUrl: "http://192.168.1.20:43123/",
        targetTag: "PrimaryConnectionTarget",
        computerLabel: "Office",
        isLoopback,
      }).onHost,
    ).toBe(false);
  });

  it("never pretends a remote viewing browser is the host", () => {
    const remote = resolveGmailHostAccess({
      httpBaseUrl: "http://192.168.1.20:43123/",
      targetTag: "SshConnectionTarget",
      computerLabel: "Office",
      isLoopback,
    });
    expect(remote.reachable).toBe(true);
    expect(remote.onHost).toBe(false);
    expect(remote.guidance).toContain("Office");
    const unnamed = resolveGmailHostAccess({
      httpBaseUrl: "https://relay.example/",
      targetTag: "RelayConnectionTarget",
      computerLabel: "  ",
      isLoopback,
    });
    expect(unnamed.guidance).toContain("that computer");
  });

  it("keeps a slow earlier status from overwriting a newer one", async () => {
    const state = createGmailConnectionState();
    let releaseFirst!: (status: GmailConnectionStatus) => void;
    const first = state.refresh(
      () =>
        new Promise<GmailConnectionStatus>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await state.refresh(async () => disconnected);
    releaseFirst(connected);
    await first;
    expect(state.getSnapshot().status).toEqual(disconnected);
  });
});
