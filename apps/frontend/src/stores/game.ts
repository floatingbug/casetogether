import {
  CatalogQuestionRequestSchema,
  ChatSendRequestSchema,
  GameErrorEventSchema,
  type CaseId,
  type CaseSummary,
  type CatalogQuestion,
  type CatalogQuestionRequest,
  type ChatSendRequest,
  type ClientRequest,
  type FinalSubmissionRequest,
  type GameSnapshot,
  type Invitation,
  type JoinRoomRequest,
  type RoomId,
  type RoomLeaveRequest,
  type RoomSnapshot,
  type RotateInvitationRequest,
  type SecretReplayResponse,
  type SessionId,
  type StartGameRequest,
  type SuspectId,
} from '@casetogether/shared';
import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';
import { casesApi } from '../api/cases';
import { gameSessionsApi } from '../api/game-sessions';
import { ApiClientError } from '../api/http';
import { roomsApi } from '../api/rooms';
import { clientErrorMessage } from '../errors/client-errors';
import { newClientRequestId } from '../idempotency';
import { RealtimeClientError, realtimeClient } from '../realtime/client';
import {
  nextReconnectCommand,
  RealtimeClientState,
  type ClientApplyResult,
} from '../realtime/client-state';
import { parseInvitationInput } from '../validation/invitation';
import { useAuthStore } from './auth';

export type RealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'synchronizing'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'error';

type RotationAttempt = RotateInvitationRequest & { roomId: RoomId };
type StartAttempt = StartGameRequest & { roomId: RoomId };
type FinalAttempt = FinalSubmissionRequest & { sessionId: SessionId };

export const useGameStore = defineStore('game', () => {
  const auth = useAuthStore();
  const machine = new RealtimeClientState();
  const room = shallowRef<RoomSnapshot | null>(null);
  const game = shallowRef<GameSnapshot | null>(null);
  const invitation = shallowRef<Invitation | null>(null);
  const lostSecret = shallowRef<SecretReplayResponse | null>(null);
  const cases = shallowRef<CaseSummary[]>([]);
  const casesLoaded = shallowRef(false);
  const connectionStatus = shallowRef<RealtimeStatus>('idle');
  const errorMessage = shallowRef('');
  const noticeMessage = shallowRef('');
  const creating = shallowRef(false);
  const joining = shallowRef(false);
  const rotating = shallowRef(false);
  const starting = shallowRef(false);
  const synchronizing = shallowRef(false);
  const loadingCases = shallowRef(false);
  const leaving = shallowRef(false);
  const sendingChat = shallowRef(false);
  const askingQuestion = shallowRef(false);
  const submittingFinal = shallowRef(false);
  const pendingLeave = shallowRef<RoomLeaveRequest | null>(null);
  const pendingChat = shallowRef<ChatSendRequest | null>(null);
  const pendingQuestion = shallowRef<{
    request: CatalogQuestionRequest;
    questionText: string;
  } | null>(null);
  const pendingFinal = shallowRef<FinalAttempt | null>(null);

  let createAttempt: ClientRequest | null = null;
  let joinAttempt: JoinRoomRequest | null = null;
  let rotationAttempt: RotationAttempt | null = null;
  let startAttempt: StartAttempt | null = null;
  let roomEpoch = 0;
  let subscriptionsInstalled = false;
  let reconnectTask: Promise<void> | null = null;
  let syncTask: Promise<boolean> | null = null;
  let leaveTask: Promise<boolean> | null = null;

  const isHost = computed(() => auth.user !== null && room.value?.room.host.id === auth.user.id);
  const hasUnconfirmedAction = computed(
    () =>
      pendingLeave.value !== null ||
      pendingChat.value !== null ||
      pendingQuestion.value !== null ||
      pendingFinal.value !== null,
  );

  function refreshVisibleState(): void {
    room.value = machine.room;
    game.value = machine.game;
  }

  function setError(error: unknown): void {
    errorMessage.value = clientErrorMessage(error);
  }

  function applyResult(result: ClientApplyResult, recover = true): ClientApplyResult {
    refreshVisibleState();
    if (result.syncRequired && recover) {
      queueMicrotask(() => {
        void syncRoom();
      });
    }
    return result;
  }

  function installRealtimeSubscriptions(): void {
    if (subscriptionsInstalled) return;
    subscriptionsInstalled = true;
    realtimeClient.subscribeConnection((event) => {
      if (event.type === 'connected') {
        connectionStatus.value = 'synchronizing';
        void handleSocketConnected();
      } else if (event.type === 'disconnected') {
        if (room.value !== null || pendingLeave.value !== null) {
          connectionStatus.value = globalThis.navigator.onLine ? 'reconnecting' : 'offline';
          noticeMessage.value = pendingLeave.value
            ? 'Verlassen ist unbestätigt. Nach dem Reconnect wird exakt dieselbe Anfrage direkt wiederholt.'
            : 'Die Live-Verbindung ist getrennt. Nach dem Reconnect wird der autoritative Raumstand geladen.';
        }
      } else {
        if (event.error.code === 'UNAUTHENTICATED') {
          reset();
          auth.clearPrivateState();
        } else {
          connectionStatus.value = globalThis.navigator.onLine ? 'error' : 'offline';
        }
        setError(event.error);
      }
    });
    realtimeClient.subscribeEvents((event) => {
      if (event.eventName === '') {
        errorMessage.value = 'Ein unbekanntes Echtzeitereignis wurde verworfen.';
        void syncRoom();
        return;
      }
      switch (event.eventName) {
        case 'room:snapshot':
          applyResult(machine.applyRoomSnapshotEvent(event.payload));
          break;
        case 'room:presence':
          applyResult(machine.applyRoomPresence(event.payload));
          break;
        case 'room:member-joined':
        case 'room:member-left':
        case 'room:closed':
        case 'room:invitation-rotated':
        case 'room:started':
          applyResult(machine.applyRoomEvent(event.payload));
          break;
        case 'chat:message':
          applyResult(machine.applyChatMessage(event.payload));
          break;
        case 'game:snapshot':
          applyResult(machine.applyGameSnapshotEvent(event.payload));
          break;
        case 'game:event': {
          const result = applyResult(machine.applyGameEvent(event.payload));
          if (result.applied) noticeMessage.value = '';
          break;
        }
        case 'game:error': {
          const parsed = GameErrorEventSchema.safeParse(event.payload);
          if (!parsed.success) {
            errorMessage.value = 'Ein ungültiger Spiel-Fehlerhinweis wurde verworfen.';
            void syncRoom();
          } else {
            setError(
              new RealtimeClientError(parsed.data.error.code, parsed.data.error.message, {
                confirmed: true,
                requestId: parsed.data.error.requestId,
                ...(parsed.data.clientRequestId === undefined
                  ? {}
                  : { clientRequestId: parsed.data.clientRequestId }),
              }),
            );
            if (parsed.data.error.code === 'VERSION_CONFLICT') void syncRoom();
          }
          break;
        }
        default:
          errorMessage.value = 'Ein unbekanntes Echtzeitereignis wurde verworfen.';
          void syncRoom();
      }
    });
  }

  async function ensureRealtimeConnection(): Promise<void> {
    installRealtimeSubscriptions();
    if (realtimeClient.connected) return;
    connectionStatus.value = globalThis.navigator.onLine ? 'connecting' : 'offline';
    try {
      await realtimeClient.connect();
    } catch (error: unknown) {
      setError(error);
    }
  }

  async function handleSocketConnected(): Promise<void> {
    if (reconnectTask !== null) return reconnectTask;
    const task = (async () => {
      const roomId = room.value?.room.id;
      const command =
        pendingLeave.value === null
          ? nextReconnectCommand(roomId === undefined ? {} : { roomId })
          : nextReconnectCommand({ pendingLeave: pendingLeave.value });
      if (command.type === 'retry-leave') {
        await leaveRoom();
        return;
      }
      if (command.type === 'none') {
        connectionStatus.value = 'connected';
        return;
      }
      const epoch = roomEpoch;
      try {
        const snapshot = await realtimeClient.joinRoom(command.request);
        if (epoch !== roomEpoch || room.value?.room.id !== command.request.roomId) return;
        const result = applyResult(machine.applySnapshot(snapshot), false);
        connectionStatus.value = 'connected';
        noticeMessage.value = '';
        if (result.syncRequired) await syncRoom();
      } catch (error: unknown) {
        if (
          error instanceof RealtimeClientError &&
          (error.code === 'UNAUTHENTICATED' || error.code === 'NOT_FOUND')
        ) {
          const message = clientErrorMessage(error);
          reset();
          if (error.code === 'UNAUTHENTICATED') auth.clearPrivateState();
          errorMessage.value = message;
        } else {
          setError(error);
          connectionStatus.value = 'error';
          if (
            error instanceof RealtimeClientError &&
            (error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_RESPONSE')
          ) {
            await syncRoom();
          }
        }
      }
    })();
    reconnectTask = task;
    try {
      await task;
    } finally {
      if (reconnectTask === task) reconnectTask = null;
    }
  }

  async function createRoom(): Promise<boolean> {
    if (creating.value) return false;
    creating.value = true;
    errorMessage.value = '';
    noticeMessage.value = '';
    const epoch = roomEpoch;
    createAttempt ??= { clientRequestId: newClientRequestId() };
    try {
      const response = await roomsApi.createRoom(createAttempt);
      if (epoch !== roomEpoch) return false;
      createAttempt = null;
      if (response.outcome === 'replayed') {
        invitation.value = null;
        lostSecret.value = response;
        noticeMessage.value =
          'Die erste Antwort mit dem Code ist nicht mehr abrufbar. Öffne den Raum und rotiere bewusst mit einer neuen Anfrage.';
        return true;
      }
      roomEpoch += 1;
      const result = machine.applyAuthoritativeSnapshot(
        {
          room: response.room,
          recentMessages: response.recentMessages,
          presence: response.presence,
        },
        null,
      );
      if (result.syncRequired) {
        errorMessage.value = 'Die Raumantwort konnte nicht sicher übernommen werden.';
        return false;
      }
      invitation.value = response.invitation;
      lostSecret.value = null;
      refreshVisibleState();
      connectAfterRoomEntry();
      return true;
    } catch (error: unknown) {
      setError(error);
      return false;
    } finally {
      creating.value = false;
    }
  }

  async function joinRoom(code: string): Promise<boolean> {
    if (joining.value) return false;
    const parsedCode = parseInvitationInput(code);
    if (!parsedCode.success) {
      errorMessage.value = 'Bitte gib den Code im Format XXXX-XXXX-XXXX ein.';
      return false;
    }
    if (joinAttempt?.code !== parsedCode.data) {
      joinAttempt = { code: parsedCode.data, clientRequestId: newClientRequestId() };
    }
    joining.value = true;
    errorMessage.value = '';
    const epoch = roomEpoch;
    try {
      const snapshot = await roomsApi.joinRoom(joinAttempt);
      const activeSessionId = snapshot.room.activeSessionId;
      const gameSnapshot =
        activeSessionId === null ? null : await gameSessionsApi.getSession(activeSessionId);
      if (epoch !== roomEpoch) return false;
      joinAttempt = null;
      roomEpoch += 1;
      const result = machine.applyAuthoritativeSnapshot(snapshot, gameSnapshot);
      if (result.syncRequired) {
        errorMessage.value = 'Die Raumantwort konnte nicht sicher übernommen werden.';
        return false;
      }
      invitation.value = null;
      lostSecret.value = null;
      refreshVisibleState();
      connectAfterRoomEntry();
      return true;
    } catch (error: unknown) {
      setError(error);
      if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') await syncRoom();
      return false;
    } finally {
      joining.value = false;
    }
  }

  function connectAfterRoomEntry(): void {
    errorMessage.value = '';
    noticeMessage.value = 'Raumdaten geladen. Die Live-Verbindung wird aufgebaut …';
    void ensureRealtimeConnection();
  }

  async function openRecoveredRoom(): Promise<boolean> {
    const roomId = lostSecret.value?.roomId;
    if (roomId === undefined) return false;
    const loaded = await loadRestRoom(roomId);
    if (loaded) connectAfterRoomEntry();
    return loaded;
  }

  async function loadRestRoom(roomId: RoomId): Promise<boolean> {
    if (pendingLeave.value !== null) return false;
    const epoch = roomEpoch;
    synchronizing.value = true;
    try {
      const snapshot = await roomsApi.getRoom(roomId);
      const activeSessionId = snapshot.room.activeSessionId;
      const gameSnapshot =
        activeSessionId === null ? null : await gameSessionsApi.getSession(activeSessionId);
      if (epoch !== roomEpoch) return false;
      const result = applyResult(machine.applyAuthoritativeSnapshot(snapshot, gameSnapshot), false);
      if (result.syncRequired) {
        errorMessage.value =
          'Die autoritativen Snapshots passen nicht zusammen. Bitte lade sie erneut.';
        return false;
      }
      noticeMessage.value = 'Der aktuelle Serverstand wurde geladen.';
      return true;
    } catch (error: unknown) {
      setError(error);
      return false;
    } finally {
      synchronizing.value = false;
    }
  }

  async function syncRoom(): Promise<boolean> {
    if (syncTask !== null) return syncTask;
    const roomId = room.value?.room.id;
    if (roomId === undefined) return false;
    if (pendingLeave.value !== null) {
      noticeMessage.value =
        'Zuerst muss der Ausgang des Verlassens mit derselben Anfrage bestätigt werden.';
      return false;
    }
    const task = (async () => {
      const epoch = roomEpoch;
      synchronizing.value = true;
      errorMessage.value = '';
      try {
        if (realtimeClient.connected) {
          const snapshot = await realtimeClient.syncRoom({ roomId });
          if (epoch !== roomEpoch || room.value?.room.id !== roomId) return false;
          const result = applyResult(machine.applySnapshot(snapshot), false);
          if (result.syncRequired)
            throw new RealtimeClientError('INVALID_RESPONSE', 'Invalid sync snapshot', {
              confirmed: false,
            });
          noticeMessage.value = 'Raum und Spiel sind mit dem Server synchronisiert.';
        } else {
          return await loadRestRoom(roomId);
        }
        return true;
      } catch (error: unknown) {
        if (
          error instanceof RealtimeClientError &&
          error.code === 'INVALID_RESPONSE' &&
          pendingLeave.value === null
        ) {
          return loadRestRoom(roomId);
        }
        if (realtimeClient.connected || pendingLeave.value !== null) {
          setError(error);
          return false;
        }
        return loadRestRoom(roomId);
      } finally {
        synchronizing.value = false;
      }
    })();
    syncTask = task;
    try {
      return await task;
    } finally {
      if (syncTask === task) syncTask = null;
    }
  }

  async function loadCases(force = false): Promise<boolean> {
    if (loadingCases.value || (casesLoaded.value && !force)) return true;
    loadingCases.value = true;
    errorMessage.value = '';
    try {
      cases.value = await casesApi.listCases();
      casesLoaded.value = true;
      return true;
    } catch (error: unknown) {
      setError(error);
      return false;
    } finally {
      loadingCases.value = false;
    }
  }

  async function rotateInvitation(): Promise<boolean> {
    const currentRoom = room.value?.room;
    if (rotating.value || currentRoom === undefined) return false;
    rotationAttempt ??= {
      roomId: currentRoom.id,
      expectedVersion: currentRoom.version,
      clientRequestId: newClientRequestId(),
    };
    const attempt = rotationAttempt;
    const epoch = roomEpoch;
    rotating.value = true;
    errorMessage.value = '';
    try {
      const response = await roomsApi.rotateInvitation(attempt);
      if (epoch !== roomEpoch) return false;
      rotationAttempt = null;
      if (response.outcome === 'replayed') {
        invitation.value = null;
        lostSecret.value = response;
        noticeMessage.value =
          'Dieser Rotations-Replay enthält absichtlich keinen Code. Erzeuge nur bei Bedarf mit einer neuen Anfrage einen neuen Code.';
        return true;
      }
      invitation.value = response.invitation;
      lostSecret.value = null;
      applyResult(machine.applyRoomSummary(response.room));
      noticeMessage.value =
        'Neuer Code erzeugt. Der vorherige Code ist ab sofort ungültig; bewahre den neuen Code jetzt auf.';
      return true;
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
        rotationAttempt = null;
        await syncRoom();
      }
      if (error instanceof ApiClientError && error.code === 'INVALID_RESPONSE') {
        await syncRoom();
      }
      setError(error);
      return false;
    } finally {
      rotating.value = false;
    }
  }

  async function startGame(caseId: CaseId): Promise<boolean> {
    const currentRoom = room.value?.room;
    if (starting.value || currentRoom === undefined) return false;
    startAttempt ??= {
      roomId: currentRoom.id,
      caseId,
      expectedVersion: currentRoom.version,
      clientRequestId: newClientRequestId(),
    };
    const attempt = startAttempt;
    const epoch = roomEpoch;
    starting.value = true;
    errorMessage.value = '';
    noticeMessage.value = '';
    try {
      if (startAttempt.caseId !== caseId) {
        errorMessage.value =
          'Bitte bestätige zuerst den Ausgang der bereits gesendeten Startanfrage.';
        return false;
      }
      await roomsApi.startGame(attempt);
      if (epoch !== roomEpoch) return false;
      startAttempt = null;
      noticeMessage.value = 'Der Start wurde bestätigt. Der vollständige Spielstand wird geladen …';
      return await syncRoom();
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
        startAttempt = null;
        await syncRoom();
      }
      if (error instanceof ApiClientError && error.code === 'INVALID_RESPONSE') {
        await syncRoom();
      }
      setError(error);
      return false;
    } finally {
      starting.value = false;
    }
  }

  async function sendChat(content: string): Promise<boolean> {
    const currentRoom = room.value?.room;
    if (sendingChat.value || currentRoom === undefined) return false;
    const parsed = ChatSendRequestSchema.safeParse({
      roomId: currentRoom.id,
      clientRequestId: newClientRequestId(),
      content,
    });
    if (!parsed.success) {
      errorMessage.value = 'Bitte gib eine Nachricht mit 1–1000 Zeichen ein.';
      return false;
    }
    pendingChat.value = parsed.data;
    return performChat(parsed.data);
  }

  async function retryChat(): Promise<boolean> {
    return pendingChat.value === null ? false : performChat(pendingChat.value);
  }

  async function performChat(request: ChatSendRequest): Promise<boolean> {
    const epoch = roomEpoch;
    sendingChat.value = true;
    errorMessage.value = '';
    try {
      const response = await realtimeClient.sendChat(request);
      if (epoch !== roomEpoch) return false;
      applyResult(machine.applyChatMessage({ message: response.message }));
      pendingChat.value = null;
      return true;
    } catch (error: unknown) {
      setError(error);
      if (error instanceof RealtimeClientError && error.code === 'INVALID_RESPONSE') {
        await syncRoom();
      }
      return false;
    } finally {
      sendingChat.value = false;
    }
  }

  async function askCatalog(question: CatalogQuestion): Promise<boolean> {
    if (askingQuestion.value || pendingQuestion.value !== null || game.value === null) return false;
    const parsed = CatalogQuestionRequestSchema.safeParse({
      sessionId: game.value.sessionId,
      clientRequestId: newClientRequestId(),
      expectedVersion: game.value.version,
      suspectId: question.suspectId,
      mode: 'catalog',
      questionId: question.questionId,
    });
    if (!parsed.success) {
      errorMessage.value = 'Diese Katalogfrage konnte nicht gesendet werden.';
      return false;
    }
    pendingQuestion.value = { request: parsed.data, questionText: question.text };
    return performCatalogQuestion(parsed.data);
  }

  async function retryCatalogQuestion(): Promise<boolean> {
    const request = pendingQuestion.value?.request;
    return request === undefined ? false : performCatalogQuestion(request);
  }

  async function performCatalogQuestion(request: CatalogQuestionRequest): Promise<boolean> {
    const epoch = roomEpoch;
    askingQuestion.value = true;
    errorMessage.value = '';
    try {
      const response = await realtimeClient.askCatalog(request);
      if (epoch !== roomEpoch) return false;
      const result = applyResult(machine.applyGameEvent(response.event));
      pendingQuestion.value = null;
      if (!result.applied && result.reason !== 'duplicate' && result.reason !== 'stale')
        return false;
      return true;
    } catch (error: unknown) {
      if (error instanceof RealtimeClientError && error.code === 'VERSION_CONFLICT') {
        pendingQuestion.value = null;
        await syncRoom();
      }
      if (error instanceof RealtimeClientError && error.code === 'QUESTION_NOT_AVAILABLE') {
        pendingQuestion.value = null;
        await syncRoom();
      }
      if (error instanceof RealtimeClientError && error.code === 'INVALID_RESPONSE') {
        await syncRoom();
      }
      setError(error);
      return false;
    } finally {
      askingQuestion.value = false;
    }
  }

  async function submitFinal(suspectId: SuspectId): Promise<boolean> {
    if (submittingFinal.value || game.value === null) return false;
    pendingFinal.value ??= {
      sessionId: game.value.sessionId,
      suspectId,
      expectedVersion: game.value.version,
      clientRequestId: newClientRequestId(),
    };
    const attempt = pendingFinal.value;
    if (attempt.suspectId !== suspectId) {
      errorMessage.value =
        'Bitte bestätige zuerst den Ausgang der bereits gesendeten finalen Abgabe.';
      return false;
    }
    const epoch = roomEpoch;
    submittingFinal.value = true;
    errorMessage.value = '';
    try {
      const snapshot = await gameSessionsApi.submitFinalSolution(attempt);
      if (epoch !== roomEpoch) return false;
      const result = applyResult(machine.applyGameSnapshot(snapshot));
      pendingFinal.value = null;
      if (result.syncRequired) await syncRoom();
      return !result.syncRequired;
    } catch (error: unknown) {
      if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
        pendingFinal.value = null;
        await syncRoom();
      }
      if (error instanceof ApiClientError && error.code === 'INVALID_RESPONSE') {
        await syncRoom();
      }
      setError(error);
      return false;
    } finally {
      submittingFinal.value = false;
    }
  }

  async function leaveRoom(): Promise<boolean> {
    if (leaveTask !== null) return leaveTask;
    const currentRoom = room.value?.room;
    if (pendingLeave.value === null && currentRoom === undefined) return false;
    if (pendingLeave.value === null) {
      if (currentRoom === undefined) return false;
      pendingLeave.value = {
        roomId: currentRoom.id,
        expectedVersion: currentRoom.version,
        clientRequestId: newClientRequestId(),
      };
    }
    const attempt = pendingLeave.value;
    const epoch = roomEpoch;
    const task = (async () => {
      leaving.value = true;
      errorMessage.value = '';
      try {
        if (!realtimeClient.connected) await ensureRealtimeConnection();
        if (!realtimeClient.connected) return false;
        await realtimeClient.leaveRoom(attempt);
        if (epoch !== roomEpoch && room.value !== null) return false;
        const wasHost = isHost.value;
        reset();
        noticeMessage.value = wasHost
          ? 'Der Server hat das Verlassen bestätigt. Der Raum wurde für das Team geschlossen.'
          : 'Der Server hat das Verlassen bestätigt.';
        return true;
      } catch (error: unknown) {
        setError(error);
        if (error instanceof RealtimeClientError && error.options.confirmed) {
          pendingLeave.value = null;
          if (error.code === 'NOT_FOUND' || error.code === 'UNAUTHENTICATED') {
            reset();
            if (error.code === 'UNAUTHENTICATED') auth.clearPrivateState();
            errorMessage.value = clientErrorMessage(error);
          } else if (error.code === 'VERSION_CONFLICT') {
            await syncRoom();
          }
        }
        return false;
      } finally {
        leaving.value = false;
      }
    })();
    leaveTask = task;
    try {
      return await task;
    } finally {
      if (leaveTask === task) leaveTask = null;
    }
  }

  function reset(): void {
    roomEpoch += 1;
    machine.clear();
    room.value = null;
    game.value = null;
    invitation.value = null;
    lostSecret.value = null;
    cases.value = [];
    casesLoaded.value = false;
    pendingLeave.value = null;
    pendingChat.value = null;
    pendingQuestion.value = null;
    pendingFinal.value = null;
    createAttempt = null;
    joinAttempt = null;
    rotationAttempt = null;
    startAttempt = null;
    creating.value = false;
    joining.value = false;
    rotating.value = false;
    starting.value = false;
    synchronizing.value = false;
    leaving.value = false;
    sendingChat.value = false;
    askingQuestion.value = false;
    submittingFinal.value = false;
    errorMessage.value = '';
    noticeMessage.value = '';
    connectionStatus.value = 'idle';
    syncTask = null;
    reconnectTask = null;
    leaveTask = null;
    realtimeClient.disconnect();
  }

  return {
    room,
    game,
    invitation,
    lostSecret,
    cases,
    casesLoaded,
    connectionStatus,
    errorMessage,
    noticeMessage,
    creating,
    joining,
    rotating,
    starting,
    synchronizing,
    loadingCases,
    leaving,
    sendingChat,
    askingQuestion,
    submittingFinal,
    pendingLeave,
    pendingChat,
    pendingQuestion,
    pendingFinal,
    isHost,
    hasUnconfirmedAction,
    createRoom,
    joinRoom,
    openRecoveredRoom,
    syncRoom,
    loadCases,
    rotateInvitation,
    startGame,
    sendChat,
    retryChat,
    askCatalog,
    retryCatalogQuestion,
    submitFinal,
    leaveRoom,
    ensureRealtimeConnection,
    handleSocketConnected,
    reset,
  };
});
