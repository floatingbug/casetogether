import { ApiClientError } from '../api/http';
import { RealtimeClientError } from '../realtime/client';

export function clientErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError) && !(error instanceof RealtimeClientError)) {
    return 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.';
  }

  switch (error.code) {
    case 'UNAUTHENTICATED':
    case 'INVALID_CREDENTIALS':
      return 'Deine Sitzung ist nicht mehr gültig. Bitte melde dich erneut an.';
    case 'CSRF_REJECTED':
      return 'Die Verbindung wurde aus Sicherheitsgründen abgelehnt. Lade die Seite neu.';
    case 'FORBIDDEN':
      return 'Du darfst diese Aktion nicht ausführen.';
    case 'NOT_FOUND':
      return 'Der Raum oder die Spielsitzung ist für dich nicht mehr verfügbar.';
    case 'ROOM_CLOSED':
      return 'Dieser Raum wurde geschlossen.';
    case 'ROOM_FULL':
      return 'Dieser Raum ist bereits voll.';
    case 'ROOM_NOT_JOINABLE':
      return 'Diesem Raum kannst du gerade nicht beitreten.';
    case 'INVITATION_INVALID':
      return 'Der Einladungscode ist ungültig oder abgelaufen. Bitte den Host um einen aktuellen Code.';
    case 'QUESTION_NOT_AVAILABLE':
      return 'Diese Frage ist gerade nicht verfügbar. Der Spielstand wird aktualisiert.';
    case 'INVALID_STATE_TRANSITION':
      return 'Diese Aktion ist im aktuellen Spielzustand nicht möglich.';
    case 'VERSION_CONFLICT':
      return 'Der Spielstand hat sich geändert. Er wird vom Server neu geladen.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Diese Anfrage konnte nicht eindeutig zugeordnet werden. Bitte lade den aktuellen Stand.';
    case 'OPERATION_IN_PROGRESS':
      return 'Eine andere Aktion wird noch verarbeitet. Du kannst den aktuellen Stand neu laden.';
    case 'RATE_LIMITED':
      return 'Zu viele Aktionen in kurzer Zeit. Bitte warte einen Moment.';
    case 'PAYLOAD_TOO_LARGE':
      return 'Die Eingabe ist zu groß. Bitte kürze sie.';
    case 'AI_UNAVAILABLE':
      return 'Der optionale KI-Dialog ist nicht verfügbar. Alle Katalogfragen bleiben nutzbar.';
    case 'NETWORK_ERROR':
    case 'ACK_TIMEOUT':
    case 'DISCONNECTED':
      return 'Der Server hat den Ausgang nicht bestätigt. Beim erneuten Versuch bleibt dieselbe Anfrage erhalten.';
    case 'INVALID_RESPONSE':
      return 'Der Server hat eine ungültige Antwort gesendet. Der aktuelle Stand wird sicherheitshalber neu geladen.';
    case 'INVALID_REQUEST':
      return 'Die Eingabe entspricht nicht dem vorgesehenen Format.';
    case 'INTERNAL_ERROR':
      return 'Auf dem Server ist ein Fehler aufgetreten. Bitte versuche es später erneut.';
    default:
      return 'Die Aktion konnte nicht abgeschlossen werden. Bitte versuche es später erneut.';
  }
}
