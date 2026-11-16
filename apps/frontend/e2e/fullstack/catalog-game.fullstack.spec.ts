import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  CreateRoomResponseEnvelopeSchema,
  GameResponseSchema,
  RoomJoinAckSchema,
  type GameEvent,
  type GameSnapshot,
} from '@casetogether/shared';
import { GameEventSchema } from '@casetogether/shared';
import { readBackendLog, readProviderEvidence, readRuntimeState } from './runtime';

const password = 'Nur-fuer-T010-lokal-123!';
const caseTitle = 'Der stille Glockenschlag';
const resolutionTitle = 'Miriam Vogt vergiftete den Abendtee';

interface QuestionStep {
  readonly actor: 'host' | 'guest';
  readonly suspect: 'Jonas Kern' | 'Selin Aras' | 'Miriam Vogt';
  readonly question: string;
}

const requiredCatalogPath: readonly QuestionStep[] = [
  {
    actor: 'host',
    suspect: 'Jonas Kern',
    question: 'Was wissen Sie über die Tasse neben Direktor Hartmann und seinen Zusammenbruch?',
  },
  {
    actor: 'host',
    suspect: 'Jonas Kern',
    question: 'Was haben Sie bei Ihrem Rundgang um 20:40 Uhr beobachtet?',
  },
  {
    actor: 'host',
    suspect: 'Jonas Kern',
    question: 'Was steht in dem Werkstattprotokoll, das Sie nach Ihrem Rundgang ausgewertet haben?',
  },
  {
    actor: 'guest',
    suspect: 'Selin Aras',
    question: 'Was geschah im Veranstaltungsablauf rund um Hartmanns Abendtee?',
  },
  {
    actor: 'host',
    suspect: 'Miriam Vogt',
    question:
      'Selin Aras sagt, Sie hätten Hartmanns Tee bestellt. Warum haben Sie das verschwiegen?',
  },
  {
    actor: 'host',
    suspect: 'Miriam Vogt',
    question:
      'Wie erklären Sie Ihre Unterschrift bei der Entnahme und den fehlenden Messkolben mit Reinigungskonzentrat?',
  },
  {
    actor: 'host',
    suspect: 'Selin Aras',
    question: 'Wer hatte nach der Vorbereitung tatsächlich Zugriff auf Hartmanns Tablett?',
  },
  {
    actor: 'host',
    suspect: 'Jonas Kern',
    question: 'Kann Ihr Aufenthalt an der Sicherheitszentrale unabhängig bestätigt werden?',
  },
  {
    actor: 'host',
    suspect: 'Selin Aras',
    question: 'Hätten Sie zwischen 20:35 und 20:50 Uhr unbemerkt die Bühne verlassen können?',
  },
];

function recordSocketFrames(page: Page, sent: string[], received: string[]): void {
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => sent.push(String(frame.payload)));
    socket.on('framereceived', (frame) => received.push(String(frame.payload)));
  });
}

async function installSocketCloseSupport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeWebSocket = globalThis.WebSocket;
    const liveSockets = new Set<WebSocket>();
    Reflect.set(globalThis, '__t010LiveSockets', liveSockets);
    globalThis.WebSocket = new Proxy(nativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget) as WebSocket;
        liveSockets.add(socket);
        socket.addEventListener('close', () => liveSockets.delete(socket));
        return socket;
      },
    });
  });
}

async function closeCurrentSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const candidate: unknown = Reflect.get(globalThis, '__t010LiveSockets');
    if (!(candidate instanceof Set)) throw new Error('QA socket registry is missing');
    const socket = [...candidate].find(
      (entry): entry is WebSocket =>
        entry instanceof WebSocket &&
        entry.url.includes('/socket.io') &&
        entry.readyState === WebSocket.OPEN,
    );
    if (socket === undefined) throw new Error('No open real WebSocket is available for reconnect');
    socket.close(1000, 'T010 controlled reconnect');
  });
}

function eventPayloads(frames: readonly string[]): GameEvent[] {
  const events: GameEvent[] = [];
  for (const frame of frames) {
    for (const packet of frame.split('\u001e')) {
      if (!packet.startsWith('42')) continue;
      try {
        const decoded: unknown = JSON.parse(packet.slice(2));
        if (!Array.isArray(decoded) || decoded[0] !== 'game:event' || decoded.length !== 2)
          continue;
        events.push(GameEventSchema.parse(decoded[1]));
      } catch (error: unknown) {
        throw new Error(`Invalid real game:event frame: ${packet}`, { cause: error });
      }
    }
  }
  return events;
}

function latestRoomJoinSnapshot(frames: readonly string[]): GameSnapshot | null {
  let latest: GameSnapshot | null = null;
  for (const frame of frames) {
    for (const packet of frame.split('\u001e')) {
      if (!packet.startsWith('43')) continue;
      const jsonStart = packet.indexOf('[');
      if (jsonStart < 0) continue;
      try {
        const decoded: unknown = JSON.parse(packet.slice(jsonStart));
        if (!Array.isArray(decoded) || decoded.length !== 1) continue;
        const ack = RoomJoinAckSchema.safeParse(decoded[0]);
        if (ack.success && ack.data.ok && ack.data.data.game !== null) latest = ack.data.data.game;
      } catch (error: unknown) {
        throw new Error(`Invalid real Socket.IO ack frame: ${packet}`, { cause: error });
      }
    }
  }
  return latest;
}

async function register(page: Page, email: string, displayName: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Anzeigename', { exact: true }).fill(displayName);
  await page.getByLabel('E-Mail-Adresse', { exact: true }).fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: `Willkommen, ${displayName}.` })).toBeVisible();
}

async function selectSuspect(page: Page, suspect: QuestionStep['suspect']): Promise<void> {
  await page
    .getByRole('group', { name: 'Verdächtigen auswählen', exact: true })
    .getByRole('button', { name: new RegExp(`^${suspect}`), exact: false })
    .click();
}

async function expectVersion(page: Page, version: number): Promise<void> {
  await expect(page.getByLabel('Bestätigte Spielversion')).toHaveText(`Stand ${version}`);
}

async function askCatalog(page: Page, step: QuestionStep, version: number): Promise<void> {
  await selectSuspect(page, step.suspect);
  const question = page.getByRole('button', { name: step.question, exact: true });
  await expect(question).toBeVisible();
  await expect(question).toBeEnabled();
  await question.click();
  const dialogue = page.locator('.dialogue-entry').filter({ hasText: step.question });
  await expect(dialogue).toHaveCount(1);
  await expect(dialogue).toContainText('Antwort:');
  await expect(dialogue).toContainText('Katalog-Referenzantwort');
  await expectVersion(page, version);
  await expect(page.getByText('Frage gesendet – Antwort noch nicht bestätigt')).toHaveCount(0);
}

async function getGameSnapshot(page: Page, sessionId: string): Promise<GameSnapshot> {
  const response = await page.request.get(`/api/v1/sessions/${sessionId}`);
  expect(response.status()).toBe(200);
  return GameResponseSchema.parse(await response.json()).data;
}

async function expectOnline(page: Page, displayName: string): Promise<void> {
  const member = page.locator('.member-list li').filter({ hasText: displayName });
  await expect(member).toHaveCount(1);
  await expect(member.locator('[data-presence="online"]')).toHaveText('online');
}

async function closeContexts(contexts: readonly BrowserContext[]): Promise<void> {
  await Promise.all(contexts.map((context) => context.close()));
}

test('real two-player catalog game survives reconnect and completes with zero provider transport', async ({
  browser,
}: {
  browser: Browser;
}) => {
  const runtime = await readRuntimeState();
  const hostContext = await browser.newContext({ baseURL: runtime.frontendOrigin });
  const guestContext = await browser.newContext({ baseURL: runtime.frontendOrigin });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const hostSent: string[] = [];
  const hostReceived: string[] = [];
  const guestSent: string[] = [];
  const guestReceived: string[] = [];
  recordSocketFrames(host, hostSent, hostReceived);
  recordSocketFrames(guest, guestSent, guestReceived);
  await installSocketCloseSupport(guest);

  try {
    await register(host, 't010-host@example.invalid', 'QA Host');
    await register(guest, 't010-guest@example.invalid', 'QA Gast');

    const createResponsePromise = host.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/rooms' &&
        response.request().method() === 'POST',
    );
    await host.getByRole('button', { name: 'Raum erstellen', exact: true }).click();
    const createdEnvelope = CreateRoomResponseEnvelopeSchema.parse(
      await (await createResponsePromise).json(),
    );
    expect(createdEnvelope.data.outcome).toBe('created');
    if (createdEnvelope.data.outcome !== 'created') throw new Error('Expected initial room secret');
    const roomId = createdEnvelope.data.room.id;
    const invitationCode = createdEnvelope.data.invitation.code;
    await expect(host.getByLabel('Aktueller Einladungscode')).toHaveText(invitationCode);

    await guest.getByLabel('Einladungscode', { exact: true }).fill(invitationCode);
    await guest.getByRole('button', { name: 'Raum beitreten', exact: true }).click();
    for (const page of [host, guest]) {
      await expect(page.locator('.member-panel .count-badge')).toHaveText('2/4');
      await expectOnline(page, 'QA Host');
      await expectOnline(page, 'QA Gast');
    }

    const lobbyMessage = 'Wir spielen ausschließlich den kuratierten Katalogpfad.';
    await host.getByLabel('Nachricht an den Raum', { exact: true }).fill(lobbyMessage);
    await host.getByRole('button', { name: 'Nachricht senden', exact: true }).click();
    for (const page of [host, guest]) {
      await expect(page.locator('.chat-messages li').filter({ hasText: lobbyMessage })).toHaveCount(
        1,
      );
    }
    await guest
      .getByLabel('Nachricht an den Raum', { exact: true })
      .fill('Gast ist live und bereit.');
    await guest.getByRole('button', { name: 'Nachricht senden', exact: true }).click();
    await expect(host.locator('.chat-messages li')).toHaveCount(2);
    await expect(guest.locator('.chat-messages li')).toHaveCount(2);

    const startResponsePromise = host.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/v1/rooms/${roomId}/start` &&
        response.request().method() === 'POST',
    );
    await host.getByRole('radio', { name: new RegExp(`^${caseTitle}`) }).check();
    await host.getByRole('button', { name: 'Fall gemeinsam starten', exact: true }).click();
    const started = GameResponseSchema.parse(await (await startResponsePromise).json()).data;
    expect(started).toMatchObject({
      roomId,
      phase: 'investigating',
      version: 1,
      result: null,
      finishedAt: null,
    });
    for (const page of [host, guest]) {
      await expect(
        page.getByRole('heading', { name: 'Ermittlung läuft', exact: true }),
      ).toBeVisible();
      await expectVersion(page, 1);
      await expect(page.getByRole('heading', { name: resolutionTitle, exact: true })).toHaveCount(
        0,
      );
    }

    for (const [index, step] of requiredCatalogPath.entries()) {
      const page = step.actor === 'host' ? host : guest;
      await askCatalog(page, step, index + 2);

      if (index === 0) {
        const firstAnswer = eventPayloads(hostReceived).find(
          (event) => event.type === 'suspect.answered' && event.version === 2,
        );
        expect(firstAnswer).toBeDefined();
        if (firstAnswer === undefined) throw new Error('Missing first real answered event');
        await expect
          .poll(() => hostReceived.filter((frame) => frame.includes(firstAnswer.eventId)).length)
          .toBe(2);
        await expect(host.locator('.dialogue-entry')).toHaveCount(1);
        await selectSuspect(guest, 'Jonas Kern');
        await expect(guest.locator('.dialogue-entry')).toHaveCount(1);
      }

      if (index === 2) {
        await expect(host.locator('.private-clues li')).toHaveCount(1);
        await expect(guest.locator('.private-clues li')).toHaveCount(0);
        await expect(guest.getByText('Du hast noch keine privaten Hinweise.')).toBeVisible();
        await expect(
          guest.getByText('persönliche handschriftliche Vermerke', { exact: false }),
        ).toHaveCount(0);

        const sentBeforeReconnect = guestSent.length;
        const receivedBeforeReconnect = guestReceived.length;
        await closeCurrentSocket(guest);
        await expect
          .poll(
            () =>
              guestSent.slice(sentBeforeReconnect).filter((frame) => frame.includes('"room:join"'))
                .length,
          )
          .toBeGreaterThan(0);
        await expect(guest.locator('.connection-card')).toHaveCount(0, { timeout: 30_000 });
        const reconnectFrames = guestReceived.slice(receivedBeforeReconnect);
        expect(latestRoomJoinSnapshot(reconnectFrames)).toMatchObject({
          sessionId: started.sessionId,
          version: 4,
          privateClues: [],
        });
        await expectVersion(guest, 4);
        await expectOnline(guest, 'QA Host');
        await expectOnline(guest, 'QA Gast');
      }

      if (step.actor === 'guest') {
        await selectSuspect(host, step.suspect);
        await expect(
          host.locator('.dialogue-entry').filter({ hasText: step.question }),
        ).toHaveCount(1);
      }
      await expectVersion(host, index + 2);
      if (step.actor === 'host' && index !== 2 && index !== 5) {
        await expectVersion(guest, index + 2);
      }
    }

    const beforeFinalHost = await getGameSnapshot(host, started.sessionId);
    const beforeFinalGuest = await getGameSnapshot(guest, started.sessionId);
    expect(beforeFinalHost.version).toBe(10);
    expect(beforeFinalGuest.version).toBe(10);
    expect(beforeFinalHost.dialogues).toHaveLength(9);
    expect(beforeFinalGuest.dialogues).toHaveLength(7);
    expect(beforeFinalHost.privateClues.map((clue) => clue.id)).toEqual([
      'clue-solvent-checkout',
      'clue-concentrate-match',
    ]);
    expect(beforeFinalGuest.privateClues).toHaveLength(0);
    const discovered = new Set(
      [...beforeFinalHost.publicClues, ...beforeFinalHost.privateClues].map((clue) => clue.id),
    );
    for (const requiredClue of [
      'clue-solvent-checkout',
      'clue-tea-arranged',
      'clue-tray-delivery',
      'clue-concentrate-match',
      'clue-jonas-alibi',
      'clue-selin-alibi',
    ]) {
      expect(discovered).toContain(requiredClue);
    }
    for (const snapshot of [beforeFinalHost, beforeFinalGuest]) {
      expect(snapshot.result).toBeNull();
      expect(snapshot.finalSubmission).toBeNull();
      expect(snapshot.finishedAt).toBeNull();
      expect(JSON.stringify(snapshot)).not.toContain(resolutionTitle);
      expect(JSON.stringify(snapshot)).not.toMatch(
        /referenceAnswer|concealedFact|tabooTopics|startIntent|aiUsage/,
      );
    }
    expect(guestReceived.join('\n')).not.toContain('clue-solvent-checkout');
    expect(guestReceived.join('\n')).not.toContain('persönliche handschriftliche Vermerke');
    expect(guestReceived.join('\n')).not.toMatch(
      /referenceAnswer|concealedFact|tabooTopics|startIntent|aiUsage|codeHash/,
    );

    await expectVersion(guest, 10);
    await guest.getByRole('radio', { name: 'Miriam Vogt', exact: true }).check();
    await guest
      .getByRole('button', { name: 'Gemeinsame Lösung verbindlich abgeben', exact: true })
      .click();
    for (const page of [host, guest]) {
      await expect(page.getByRole('heading', { name: resolutionTitle, exact: true })).toBeVisible();
      await expect(page.getByText('Richtige Gruppenlösung')).toBeVisible();
      await expect(page.getByText('100/100 Punkte', { exact: false })).toBeVisible();
      await expect(page.getByText('Abgeschlossen am', { exact: false })).toBeVisible();
      await expectVersion(page, 11);
    }

    const [completedHost, completedGuest] = await Promise.all([
      getGameSnapshot(host, started.sessionId),
      getGameSnapshot(guest, started.sessionId),
    ]);
    for (const snapshot of [completedHost, completedGuest]) {
      expect(snapshot).toMatchObject({
        phase: 'completed',
        version: 11,
        result: {
          verdict: 'correct',
          awardedPoints: 100,
          maximumPoints: 100,
          resolution: { suspectId: 'miriam-vogt', title: resolutionTitle },
        },
        finishedAt: expect.any(String),
      });
      expect(snapshot.finalSubmission?.submittedBy.displayName).toBe('QA Gast');
    }
    expect(completedHost.dialogues).toHaveLength(9);
    expect(completedGuest.dialogues).toHaveLength(7);
    expect(completedGuest.privateClues).toHaveLength(0);
    expect(completedHost.finishedAt).toBe(completedGuest.finishedAt);
    expect(
      eventPayloads(hostReceived).filter((event) => event.type === 'game.completed'),
    ).toHaveLength(1);
    expect(
      eventPayloads(guestReceived).filter((event) => event.type === 'game.completed'),
    ).toHaveLength(1);
    for (const page of [host, guest]) {
      expect(
        await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
      ).toEqual({ local: 0, session: 0 });
    }

    const providerEvidence = await readProviderEvidence();
    expect(providerEvidence.providerEnvironmentKeysAfterSanitization).toEqual([]);
    expect(providerEvidence.providerTransportAttempts).toEqual([]);
    expect(providerEvidence.productionMainImported).toBe(true);
    const backendLog = await readBackendLog();
    expect(backendLog).not.toContain(invitationCode);
    expect(backendLog).not.toMatch(/OPENAI_API_KEY|concealedFact|referenceAnswer/);
    expect(guestReceived.join('\n')).not.toContain(invitationCode);
  } finally {
    await closeContexts([hostContext, guestContext]);
  }
});
