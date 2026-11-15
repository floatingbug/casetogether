import { ApiClientError } from '../api/http';

export type AuthFormContext = 'login' | 'register' | 'general';

export function authErrorMessage(error: unknown, context: AuthFormContext = 'general'): string {
  if (!(error instanceof ApiClientError)) {
    return 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.';
  }

  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return 'E-Mail-Adresse oder Passwort ist falsch.';
    case 'EMAIL_ALREADY_REGISTERED':
      return context === 'register'
        ? 'Für diese E-Mail-Adresse existiert bereits ein Konto. Du kannst dich anmelden.'
        : 'Diese Aktion ist nicht möglich. Bitte versuche es erneut.';
    case 'VALIDATION_ERROR':
      return 'Die Eingaben wurden vom Server nicht akzeptiert. Bitte prüfe sie und versuche es erneut.';
    case 'UNAUTHENTICATED':
      return 'Deine Sitzung ist nicht mehr gültig. Bitte melde dich erneut an.';
    case 'NOT_FOUND':
      return 'Die angeforderte Ressource ist nicht verfügbar.';
    case 'CSRF_REJECTED':
      return 'Die Anfrage wurde aus Sicherheitsgründen abgelehnt. Lade die Seite neu und versuche es erneut.';
    case 'FORBIDDEN':
      return 'Du darfst diese Aktion nicht ausführen.';
    case 'RATE_LIMITED':
      return 'Zu viele Versuche. Bitte warte einen Moment und versuche es erneut.';
    case 'PAYLOAD_TOO_LARGE':
      return 'Die Eingaben sind zu groß. Bitte kürze sie und versuche es erneut.';
    case 'NETWORK_ERROR':
      return 'Der Server ist nicht erreichbar. Prüfe deine Internetverbindung und versuche es erneut.';
    case 'INVALID_REQUEST':
      return 'Die Eingaben konnten nicht gesendet werden. Bitte prüfe sie und versuche es erneut.';
    case 'INVALID_RESPONSE':
      return 'Der Server hat eine unerwartete Antwort gesendet. Bitte versuche es später erneut.';
    case 'INTERNAL_ERROR':
      return 'Auf dem Server ist ein Fehler aufgetreten. Bitte versuche es später erneut.';
    default:
      return 'Die Anfrage konnte nicht ausgeführt werden. Bitte versuche es später erneut.';
  }
}
