import {
  CaseIdSchema,
  CaseResolutionSchema,
  CaseSummarySchema,
  CaseVersionSchema,
  ClueIdSchema,
  PublicSuspectSchema,
  QuestionIdSchema,
  SuspectIdSchema,
} from '@casetogether/shared';
import type { CaseClueDefinition, CaseDefinition, CaseQuestionDefinition } from '../types.js';

export const glockenschlagIds = {
  caseId: CaseIdSchema.parse('der-stille-glockenschlag'),
  suspects: {
    miriam: SuspectIdSchema.parse('miriam-vogt'),
    jonas: SuspectIdSchema.parse('jonas-kern'),
    selin: SuspectIdSchema.parse('selin-aras'),
  },
  questions: {
    miriamEvening: QuestionIdSchema.parse('q-miriam-evening'),
    miriamCabinet: QuestionIdSchema.parse('q-miriam-cabinet'),
    miriamTea: QuestionIdSchema.parse('q-miriam-tea'),
    miriamConcentrate: QuestionIdSchema.parse('q-miriam-concentrate'),
    jonasRound: QuestionIdSchema.parse('q-jonas-round'),
    jonasControl: QuestionIdSchema.parse('q-jonas-control'),
    jonasTeacup: QuestionIdSchema.parse('q-jonas-teacup'),
    jonasInventory: QuestionIdSchema.parse('q-jonas-inventory'),
    selinProgram: QuestionIdSchema.parse('q-selin-program'),
    selinSpeech: QuestionIdSchema.parse('q-selin-speech'),
    selinTray: QuestionIdSchema.parse('q-selin-tray'),
    selinMasterKey: QuestionIdSchema.parse('q-selin-master-key'),
  },
  clues: {
    solitaryWork: ClueIdSchema.parse('clue-solitary-restoration'),
    serviceCorridor: ClueIdSchema.parse('clue-service-corridor'),
    poisonedTea: ClueIdSchema.parse('clue-poisoned-tea'),
    cabinetAccess: ClueIdSchema.parse('clue-cabinet-access'),
    inventoryRecord: ClueIdSchema.parse('clue-inventory-record'),
    solventCheckout: ClueIdSchema.parse('clue-solvent-checkout'),
    teaRequest: ClueIdSchema.parse('clue-tea-request'),
    teaArranged: ClueIdSchema.parse('clue-tea-arranged'),
    trayDelivery: ClueIdSchema.parse('clue-tray-delivery'),
    concentrateMatch: ClueIdSchema.parse('clue-concentrate-match'),
    jonasAlibi: ClueIdSchema.parse('clue-jonas-alibi'),
    selinAlibi: ClueIdSchema.parse('clue-selin-alibi'),
    masterKey: ClueIdSchema.parse('clue-master-key'),
  },
} as const;

const publicSuspects: CaseDefinition['publicSuspects'] = [
  PublicSuspectSchema.parse({
    id: glockenschlagIds.suspects.miriam,
    displayName: 'Miriam Vogt',
    publicDescription:
      'Die 42-jährige Uhrenrestauratorin betreut die historische Sammlung und war am Abend allein in ihrer Werkstatt. Sie arbeitet präzise, antwortet knapp und hatte Zugang zum Galerie-Nebeneingang sowie zu den Werkstattmaterialien.',
  }),
  PublicSuspectSchema.parse({
    id: glockenschlagIds.suspects.jonas,
    displayName: 'Jonas Kern',
    publicDescription:
      'Der 58-jährige Nachtwächter kennt jede Tür und jeden Fluchtwinkel des Museums. Er führte die Rundgänge durch, bediente die Sicherheitszentrale und alarmierte nach dem Zusammenbruch des Direktors den Notarzt.',
  }),
  PublicSuspectSchema.parse({
    id: glockenschlagIds.suspects.selin,
    displayName: 'Selin Aras',
    publicDescription:
      'Die 35-jährige Veranstaltungsleiterin organisierte den Benefizabend, koordinierte Service und Bühnenprogramm und hielt vor zahlreichen Gästen eine Ansprache. Sie kannte die persönlichen Vorlieben des Direktors und den Ablauf hinter den Kulissen.',
  }),
];

const suspectDefinitions: CaseDefinition['suspectDefinitions'] = [
  {
    id: glockenschlagIds.suspects.miriam,
    personality: 'Kontrolliert, fachlich stolz und bei Widersprüchen zunehmend einsilbig.',
    knownFacts: [
      'Werkstattzeiten und Restaurierungsarbeiten am astronomischen Uhrwerk',
      'Entnahmeprotokoll und Lagerung der Reinigungsmittel',
      'Weg über den Lieferantenflur zur Galerie',
    ],
    secret: {
      concealedFact:
        'Miriam verbarg den Verlust ihrer Zulassung nach einem vertuschten Restaurierungsschaden.',
      tabooTopics: ['Vertuschter Schaden an der Himmelsuhr', 'Geplante Kündigung durch Hartmann'],
    },
    allowedStatements: [
      'Sie bat Selin um den Abendtee.',
      'Sie trug das Tablett in die Galerie.',
      'Ihre Unterschrift steht im Entnahmeprotokoll.',
    ],
    speechStyle: 'Sachlich, kurze Sätze, technische Bezeichnungen nur wenn nachgefragt.',
  },
  {
    id: glockenschlagIds.suspects.jonas,
    personality: 'Herzlich, redselig, aber bei Lücken im Wachprotokoll nervös.',
    knownFacts: [
      'Rundgänge und Sicherheitszentrale',
      'Stand der Türsensoren und Funkprotokolle',
      'Inventurablage in der Restaurierungswerkstatt',
    ],
    secret: {
      concealedFact:
        'Jonas verschob zunächst einen Rundgang um sechs Minuten, weil er einen Fehler im Dienstbuch fürchtete.',
      tabooTopics: ['Verspäteter erster Rundgang', 'Privates Gespräch mit dem Museumsverein'],
    },
    allowedStatements: [
      'Er war während des Tatzeitfensters an der Sicherheitszentrale nachweisbar.',
      'Er fand das Inventurprotokoll mit Miriams Unterschrift.',
      'Der Generalschlüssel blieb bei ihm.',
    ],
    speechStyle: 'Anschauliche Alltagssprache, zeitliche Angaben werden besonders genau.',
  },
  {
    id: glockenschlagIds.suspects.selin,
    personality: 'Energiegeladen, organisiert und offen über Programmentscheidungen.',
    knownFacts: [
      'Bühnenzeiten und Livestream-Aufzeichnung',
      'Teebestellung und Servierweg',
      'Gästebetreuung im Foyer',
    ],
    secret: {
      concealedFact:
        'Selin strich ohne Zustimmung des Direktors dessen kritische Eröffnungsrede aus dem Programm.',
      tabooTopics: [
        'Streit über die gekürzte Eröffnungsrede',
        'Budgetüberschreitung beim Catering',
      ],
    },
    allowedStatements: [
      'Miriam bestellte den Tee für den Direktor.',
      'Miriam holte das Tablett selbst ab.',
      'Selin war während ihrer Ansprache durchgehend im Livestream zu sehen.',
    ],
    speechStyle: 'Lebhaft und kooperativ, ordnet Aussagen gern in den Veranstaltungsablauf ein.',
  },
];

function question(definition: CaseQuestionDefinition): CaseQuestionDefinition {
  return definition;
}

const questions: CaseDefinition['questions'] = [
  question({
    questionId: glockenschlagIds.questions.miriamEvening,
    suspectId: glockenschlagIds.suspects.miriam,
    text: 'Wo waren Sie zwischen 20:30 und 21:00 Uhr, und hatten Sie Kontakt zu Direktor Hartmann?',
    referenceAnswer:
      'Ich habe von 20:20 bis kurz vor 21:00 Uhr allein am astronomischen Uhrwerk gearbeitet. Direktor Hartmann habe ich nach 20:15 Uhr nicht mehr gesehen und auch nichts für ihn bestellt. Um 20:50 Uhr bin ich über den Lieferantenflur zur Garderobe gegangen.',
    visibility: 'room',
    requiresQuestionIds: [],
    clueIds: [glockenschlagIds.clues.solitaryWork],
  }),
  question({
    questionId: glockenschlagIds.questions.miriamCabinet,
    suspectId: glockenschlagIds.suspects.miriam,
    text: 'Wer konnte während des Benefizabends auf den gesicherten Reinigungsmittelschrank zugreifen?',
    referenceAnswer:
      'Der Schrank war abgeschlossen. Ich besitze den Werkstattschlüssel; der Ersatzschlüssel lag laut Übergabeverschluss ungeöffnet im Büro des Direktors. Jonas’ Generalschlüssel öffnet Türen, aber nicht diesen separaten Chemikalienschrank.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.miriamEvening],
    clueIds: [glockenschlagIds.clues.cabinetAccess],
  }),
  question({
    questionId: glockenschlagIds.questions.miriamTea,
    suspectId: glockenschlagIds.suspects.miriam,
    text: 'Selin Aras sagt, Sie hätten Hartmanns Tee bestellt. Warum haben Sie das verschwiegen?',
    referenceAnswer:
      'Gut, ich bat Selin um 20:25 Uhr um den Tee. Ich wollte mit Hartmann unter vier Augen über die Restaurierung sprechen und fürchtete, dass mein Alleinsein sonst falsch gedeutet wird. Um 20:43 Uhr holte ich das Tablett ab und stellte es in der Galerie auf seinen Schreibtisch; mehr habe ich nicht getan.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.selinProgram],
    clueIds: [glockenschlagIds.clues.teaArranged],
  }),
  question({
    questionId: glockenschlagIds.questions.miriamConcentrate,
    suspectId: glockenschlagIds.suspects.miriam,
    text: 'Wie erklären Sie Ihre Unterschrift bei der Entnahme und den fehlenden Messkolben mit Reinigungskonzentrat?',
    referenceAnswer:
      'Die Unterschrift von 20:05 Uhr ist meine. Den Messkolben habe ich für eine Prüfung an meinen Arbeitsplatz genommen, aber er war bei der Rückgabe nicht mehr dort. Das Labor sagt, die Rückstände in Hartmanns Tasse und im Kolben stammen aus genau dieser Charge. Jemand muss das Präparat aus meiner Werkstatt genommen haben.',
    visibility: 'actor',
    requiresQuestionIds: [
      glockenschlagIds.questions.miriamTea,
      glockenschlagIds.questions.jonasInventory,
    ],
    clueIds: [glockenschlagIds.clues.concentrateMatch],
  }),
  question({
    questionId: glockenschlagIds.questions.jonasRound,
    suspectId: glockenschlagIds.suspects.jonas,
    text: 'Was haben Sie bei Ihrem Rundgang um 20:40 Uhr beobachtet?',
    referenceAnswer:
      'Die Galerie war um 20:38 Uhr noch leer. Anschließend sah ich Miriam um 20:43 Uhr mit einem Tablett im Lieferantenflur; sie kam aus Richtung Veranstaltungsküche. Bei meinem nächsten Rundgang fand ich Hartmann um 21:02 Uhr bewusstlos. Die Außentüren waren währenddessen verriegelt.',
    visibility: 'room',
    requiresQuestionIds: [],
    clueIds: [glockenschlagIds.clues.serviceCorridor],
  }),
  question({
    questionId: glockenschlagIds.questions.jonasControl,
    suspectId: glockenschlagIds.suspects.jonas,
    text: 'Kann Ihr Aufenthalt an der Sicherheitszentrale unabhängig bestätigt werden?',
    referenceAnswer:
      'Zwischen 20:38 und 20:53 Uhr habe ich alle neunzig Sekunden die wechselnden Kontrollcodes der Zentrale bestätigt. Die Funkaufzeichnung und die Maschinenprotokolle stimmen überein; niemand kann diese Bestätigungen nachträglich einspielen. Mein kurzer Gang zur Galerie begann erst um 20:54 Uhr.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.jonasRound],
    clueIds: [glockenschlagIds.clues.jonasAlibi],
  }),
  question({
    questionId: glockenschlagIds.questions.jonasTeacup,
    suspectId: glockenschlagIds.suspects.jonas,
    text: 'Was wissen Sie über die Tasse neben Direktor Hartmann und seinen Zusammenbruch?',
    referenceAnswer:
      'Hartmann lag neben seinem Schreibtisch; seine Lieblingstasse war halb leer. Die spätere Laboruntersuchung fand darin ein hochgiftiges Reinigungskonzentrat der Restaurierung. Auf einer unbenutzten zweiten Tasse und auf der Kanne gab es keine solchen Rückstände.',
    visibility: 'room',
    requiresQuestionIds: [],
    clueIds: [glockenschlagIds.clues.poisonedTea],
  }),
  question({
    questionId: glockenschlagIds.questions.jonasInventory,
    suspectId: glockenschlagIds.suspects.jonas,
    text: 'Was steht in dem Werkstattprotokoll, das Sie nach Ihrem Rundgang ausgewertet haben?',
    referenceAnswer:
      'Nur für Ihre Ermittlungsakte: Miriam hat um 20:05 Uhr einen versiegelten Messkolben Reinigungskonzentrat ausgecheckt. Ihre Unterschrift und die Chargennummer stehen direkt daneben. Das aktuelle Inventurblatt liegt vor; die persönlichen handschriftlichen Vermerke gebe ich nur an die Person weiter, die danach fragt.',
    visibility: 'actor',
    requiresQuestionIds: [glockenschlagIds.questions.jonasRound],
    clueIds: [glockenschlagIds.clues.inventoryRecord, glockenschlagIds.clues.solventCheckout],
  }),
  question({
    questionId: glockenschlagIds.questions.selinProgram,
    suspectId: glockenschlagIds.suspects.selin,
    text: 'Was geschah im Veranstaltungsablauf rund um Hartmanns Abendtee?',
    referenceAnswer:
      'Miriam bat mich um 20:25 Uhr ausdrücklich um Hartmanns Abendtee in der Galerie. Der Service stellte Kanne, zwei Tassen und sein gewohntes Gebäck bereit. Zunächst wollte der Service liefern; wenig später kam Miriam selbst zum Abholen. Meine Bühnenansprache begann um 20:32 Uhr.',
    visibility: 'room',
    requiresQuestionIds: [],
    clueIds: [glockenschlagIds.clues.teaRequest],
  }),
  question({
    questionId: glockenschlagIds.questions.selinSpeech,
    suspectId: glockenschlagIds.suspects.selin,
    text: 'Hätten Sie zwischen 20:35 und 20:50 Uhr unbemerkt die Bühne verlassen können?',
    referenceAnswer:
      'Nein. Der Livestream zeigt mich von 20:32 bis 20:52 Uhr ohne Schnitt auf der Bühne; zwei Fotografen und das gesamte Publikum bestätigen das. Meine Moderationskarten und die Zeitmarken der Kamera decken exakt das Tatzeitfenster ab.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.selinProgram],
    clueIds: [glockenschlagIds.clues.selinAlibi],
  }),
  question({
    questionId: glockenschlagIds.questions.selinTray,
    suspectId: glockenschlagIds.suspects.selin,
    text: 'Wer hatte nach der Vorbereitung tatsächlich Zugriff auf Hartmanns Tablett?',
    referenceAnswer:
      'Der Kameramitschnitt zeigt, dass Miriam das geschlossene Tablett um 20:43 Uhr aus der Küche nahm und in Richtung Lieferantenflur trug. Niemand sonst berührte es davor; ich wurde erst nach meiner Ansprache wieder in der Küche gesehen. Hartmanns Tasse wurde bereits vor Miriams Abholung auf das Tablett gestellt.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.miriamTea],
    clueIds: [glockenschlagIds.clues.trayDelivery],
  }),
  question({
    questionId: glockenschlagIds.questions.selinMasterKey,
    suspectId: glockenschlagIds.suspects.selin,
    text: 'Wie konnte jemand die Galerie betreten, ohne die verriegelten Außentüren zu öffnen?',
    referenceAnswer:
      'Generalschlüssel und Galerie-Nebeneingang sind getrennte Systeme. Jonas trug den Generalschlüssel sichtbar am Gürtel, doch der Lieferantenflur gehört tagsüber zur Werkstattzone. Miriams Werkstattschlüssel öffnet auch am Abend die Verbindungstür zur Galerie; dafür brauchte sie Jonas’ Schlüssel nicht.',
    visibility: 'room',
    requiresQuestionIds: [glockenschlagIds.questions.jonasRound],
    clueIds: [glockenschlagIds.clues.masterKey],
  }),
];

function clue(definition: CaseClueDefinition): CaseClueDefinition {
  return definition;
}

const clues: CaseDefinition['clues'] = [
  clue({
    id: glockenschlagIds.clues.solitaryWork,
    title: 'Allein in der Werkstatt',
    text: 'Für Miriams angebliche durchgehende Arbeit am Uhrwerk gibt es keine zweite Zeugin und keinen lückenlosen Maschinennachweis.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.serviceCorridor,
    title: 'Tablett im Lieferantenflur',
    text: 'Jonas sah Miriam um 20:43 Uhr mit einem Tablett im Lieferantenflur, deren Werkstattschlüssel den Weg zur Galerie öffnet.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.poisonedTea,
    title: 'Reinigungskonzentrat in der Lieblingstasse',
    text: 'Nur Hartmanns halb leere Lieblingstasse enthielt das Reinigungskonzentrat der Restaurierung; Kanne und zweite Tasse waren unauffällig.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.cabinetAccess,
    title: 'Separater Chemikalienschrank',
    text: 'Der Generalschlüssel öffnete den Chemikalienschrank nicht. Miriam besaß den Werkstattschlüssel; der Ersatzschlüssel blieb versiegelt.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.inventoryRecord,
    title: 'Aktuelles Inventurprotokoll',
    text: 'In der Restaurierungswerkstatt wurde ein aktuelles Protokoll über die Entnahme von Reinigungsmitteln ausgewertet.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.solventCheckout,
    title: 'Signierte Konzentratentnahme',
    text: 'Die private Aktennotiz verbindet Miriams Unterschrift von 20:05 Uhr eindeutig mit dem versiegelten Messkolben und seiner Chargennummer.',
    visibility: 'actor',
  }),
  clue({
    id: glockenschlagIds.clues.teaRequest,
    title: 'Teebestellung um 20:25 Uhr',
    text: 'Selin bestätigt Miriams ausdrückliche Bitte, Hartmanns Abendtee in der Galerie bereitzustellen.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.teaArranged,
    title: 'Zugegebenes Teearrangement',
    text: 'Miriam räumt nach dem anfänglichen Bestreiten ein, den Tee bestellt und das Tablett um 20:43 Uhr selbst in die Galerie gebracht zu haben.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.trayDelivery,
    title: 'Ununterbrochener Servierweg',
    text: 'Kamera- und Personalangaben begrenzen den Kontakt mit dem Tablett nach seiner Vorbereitung auf Miriam. Sie trug es um 20:43 Uhr selbst aus der Küche.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.concentrateMatch,
    title: 'Chargenabgleich und fehlender Messkolben',
    text: 'Die private Labornotiz verbindet die Rückstände in Tasse und Messkolben mit derselben Charge. Miriam bestätigt ihre Unterschrift und den fehlenden Kolben.',
    visibility: 'actor',
  }),
  clue({
    id: glockenschlagIds.clues.jonasAlibi,
    title: 'Geschlossenes Kontrollprotokoll für Jonas',
    text: 'Wechselnde Kontrollcodes, Funkaufzeichnung und Maschinenprotokolle belegen Jonas’ Anwesenheit an der Zentrale während des Tatzeitfensters.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.selinAlibi,
    title: 'Lückenloser Livestream für Selin',
    text: 'Der ungeschnittene Livestream sowie Fotografen und Publikum schließen einen unbemerkten Weg Selins zur Galerie zwischen 20:35 und 20:50 Uhr aus.',
    visibility: 'room',
  }),
  clue({
    id: glockenschlagIds.clues.masterKey,
    title: 'Unabhängiger Werkstattzugang',
    text: 'Jonas’ Generalschlüssel war für den Weg über den Lieferantenflur nicht erforderlich; Miriams Werkstattschlüssel öffnete die Verbindungstür selbst.',
    visibility: 'room',
  }),
];

export const STILLER_GLOCKENSCHLAG_CASE: CaseDefinition = {
  schemaVersion: 1,
  id: glockenschlagIds.caseId,
  version: CaseVersionSchema.parse('1.0.0'),
  status: 'published',
  summary: CaseSummarySchema.parse({
    id: glockenschlagIds.caseId,
    title: 'Der stille Glockenschlag',
    description:
      'Während eines Benefizabends im Museum für Zeitmessung bricht Direktor Leo Hartmann in der verschlossenen Glockengalerie zusammen. Eine halb leere Teetasse, ein ausgefallener Glockenschlag um 20:47 Uhr und drei unterschiedliche Zeitzeugen führen durch den Fall. Befragt die Restauratorin, den Nachtwächter und die Veranstaltungsleiterin, gleicht Aussagen mit Protokollen ab und überführt den Täter mit einer belastbaren Beweiskette.',
    estimatedDurationMinutes: 30,
  }),
  publicSuspects,
  suspectDefinitions,
  questions,
  clues,
  truth: {
    culpritId: glockenschlagIds.suspects.miriam,
    resolution: CaseResolutionSchema.parse({
      suspectId: glockenschlagIds.suspects.miriam,
      title: 'Miriam Vogt vergiftete den Abendtee',
      explanation:
        'Miriam Vogt fürchtete die Entdeckung eines vertuschten Restaurierungsschadens und den Verlust ihrer Zulassung. Um 20:05 Uhr zeichnete sie den Messkolben mit dem Reinigungskonzentrat aus und bestellte um 20:25 Uhr Hartmanns Tee. Der Kamera- und Personalnachweis zeigt, dass nur sie das vorbereitete Tablett anschließend berührte und um 20:43 Uhr trug. Ihre Werkstattschlüssel erklären den unauffälligen Weg durch den Lieferantenflur. Tassenrückstände und Messkolben stammen aus derselben Charge; die Unterschrift und der fehlende Kolben schließen die Beweiskette. Jonas wurde durch die manipulationsgeschützten Kontrollprotokolle, Selin durch den ungeschnittenen Livestream und unabhängige Zeugen ausgeschlossen. Miriams anfänglich falsche Aussage über die Teebestellung und ihr später eingeräumter Servierweg erklären den Widerspruch, ohne die übrigen Beweise zu ersetzen.',
    }),
    requiredEvidenceClueIds: [
      glockenschlagIds.clues.solventCheckout,
      glockenschlagIds.clues.teaArranged,
      glockenschlagIds.clues.trayDelivery,
      glockenschlagIds.clues.concentrateMatch,
      glockenschlagIds.clues.jonasAlibi,
      glockenschlagIds.clues.selinAlibi,
    ],
    pointsPerEvidenceClue: 10,
    correctVerdictBonus: 40,
    maximumPoints: 100,
  },
};
