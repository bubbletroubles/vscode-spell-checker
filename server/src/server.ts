// cSpell:ignore pycache

import {
    createConnection, IConnection,
    TextDocuments, TextDocument,
    InitializeResult,
    InitializeParams,
} from 'vscode-languageserver';
import * as vscode from 'vscode-languageserver';
import { TextDocumentUri, TextDocumentUriLangId } from './vscode.workspaceFolders';
import { CancellationToken } from 'vscode-jsonrpc';
import * as Validator from './validator';
import * as Rx from 'rxjs/Rx';
import { onCodeActionHandler } from './codeActions';
import { ExclusionHelper, Text } from 'cspell';
import {
    Glob
} from 'cspell';
import * as path from 'path';

import * as CSpell from 'cspell';
import { CSpellUserSettings } from './cspellConfig';
import { getDefaultSettings } from 'cspell';
import * as Api from './api';
import { DocumentSettings, SettingsCspell } from './documentSettings';

const methodNames: Api.RequestMethodConstants = {
    isSpellCheckEnabled: 'isSpellCheckEnabled',
    getConfigurationForDocument: 'getConfigurationForDocument',
    splitTextIntoWords: 'splitTextIntoWords',
};

const {
    extractGlobsFromExcludeFilesGlobMap,
    generateExclusionFunctionForUri,
} = ExclusionHelper;

const tds = CSpell;

const defaultCheckLimit = Validator.defaultCheckLimit;

// Turn off the spell checker by default. The setting files should have it set.
// This prevents the spell checker from running too soon.
const defaultSettings: CSpellUserSettings = {
    ...CSpell.mergeSettings(getDefaultSettings(), CSpell.getGlobalSettings()),
    checkLimit: defaultCheckLimit,
    enabled: false,
};
const defaultDebounce = 50;
let activeSettingsNeedUpdating = false;

const defaultExclude: Glob[] = [
    'debug:*',
    'debug:/**',        // Files that are generated while debugging (generally from a .map file)
    'vscode:/**',       // VS Code generated files (settings.json for example)
    'private:/**',
    'markdown:/**',     // The HTML generated by the markdown previewer
    'git-index:/**',    // Ignore files loaded for git indexing
    '**/*.rendered',
    '**/*.*.rendered',
    '__pycache__/**',   // ignore cache files.
];

const configsToImport = new Set<string>();

interface VsCodeSettings {
    [key: string]: any;
}

let g_connection: IConnection;

const startTs = Date.now();
const enableLogging = false;

function log(msg: string) {
    if (enableLogging && g_connection) {
        const ts = Date.now() - startTs;
        g_connection.console.log(`${ts} ${msg}`);
    }
};

function run() {
    // debounce buffer
    const validationRequestStream = new Rx.ReplaySubject<TextDocument>(1);
    const validationFinishedStream = new Rx.ReplaySubject<{ uri: string; version: number }>(1);
    const triggerUpdateConfig = new Rx.ReplaySubject<void>(1);
    const triggerValidateAll = new Rx.ReplaySubject<void>(1);

    // Create a connection for the server. The connection uses Node's IPC as a transport
    const connection = createConnection(vscode.ProposedFeatures.all);
    g_connection = connection;
    log('Start');

    const documentSettings = new DocumentSettings(connection, defaultSettings);

    // Create a simple text document manager. The text document manager
    // supports full document sync only
    const documents: TextDocuments = new TextDocuments();

    // After the server has started the client sends an initialize request. The server receives
    // in the passed params the rootPath of the workspace plus the client capabilities.
    let workspaceRoot: string | undefined;
    connection.onInitialize((params: InitializeParams, token: CancellationToken): InitializeResult => {
        workspaceRoot = params.rootPath || undefined;
        return {
            capabilities: {
                // Tell the client that the server works in FULL text document sync mode
                textDocumentSync: documents.syncKind,
                codeActionProvider: true
            }
        };
    });

    // The settings have changed. Is sent on server activation as well.
    connection.onDidChangeConfiguration(onConfigChange);

    interface OnChangeParam { settings: SettingsCspell; }
    function onConfigChange(change: OnChangeParam) {
        log('onConfigChange');
        triggerUpdateConfig.next(undefined);
    }

    function updateActiveSettings() {
        log('updateActiveSettings');
        documentSettings.resetSettings();
        activeSettingsNeedUpdating = false;
        triggerValidateAll.next(undefined);
    }

    function getActiveSettings(doc: TextDocumentUri) {
        return getActiveUriSettings(doc.uri);
    }

    function getActiveUriSettings(uri?: string) {
        if (activeSettingsNeedUpdating) {
            updateActiveSettings();
        }
        return documentSettings.getUriSettings(uri);
    }

    function registerConfigurationFile(path: string) {
        configsToImport.add(path);
        log(`Load: ${path}`);
        triggerUpdateConfig.next(undefined);
    }

    interface TextDocumentInfo {
        uri?: string;
        languageId?: string;
        text?: string;
    }

    // Listen for event messages from the client.
    connection.onNotification('applySettings', onConfigChange);
    connection.onNotification('registerConfigurationFile', registerConfigurationFile);

    connection.onRequest(methodNames.isSpellCheckEnabled, async (params: TextDocumentInfo): Promise<Api.IsSpellCheckEnabledResult> => {
        const { uri, languageId } = params;
        const fileEnabled = uri ? !await isUriExcluded(uri) : undefined;
        return {
            languageEnabled: languageId && uri ? await isLanguageEnabled({ uri, languageId }) : undefined,
            fileEnabled,
        };
    });

    connection.onRequest(methodNames.getConfigurationForDocument, async (params: TextDocumentInfo): Promise<Api.GetConfigurationForDocumentResult> => {
        const { uri, languageId } = params;
        const doc = uri && documents.get(uri);
        const docSettings = doc && await getSettingsToUseForDocument(doc) || undefined;
        const settings = await getActiveUriSettings(uri);
        return {
            languageEnabled: languageId && doc ? await isLanguageEnabled(doc) : undefined,
            fileEnabled: uri ? !await isUriExcluded(uri) : undefined,
            settings,
            docSettings,
        };
    });

    function textToWords(text: string): string[] {
        const setOfWords = new Set(
            Text.extractWordsFromCode(text)
                .map(t => t.text)
                .map(t => t.toLowerCase())
            );
        return [...setOfWords];
    }

    connection.onRequest(methodNames.splitTextIntoWords, (text: string): Api.SplitTextIntoWordsResult => {
        return {
            words: textToWords(text),
        };
    });

    interface DocSettingPair {
        doc: TextDocument,
        settings: CSpellUserSettings;
    }

    // validate documents
    let lastValidated = '';
    let lastDurationSelector: Rx.Subject<number> | undefined;
    const disposeValidationStream = validationRequestStream
        .do(doc => log(`A Validate ${doc.uri}:${doc.version}`))
        .flatMap(async doc => ({ doc, settings: await getActiveSettings(doc)}) as DocSettingPair )
        .flatMap(async dsp => await shouldValidateDocument(dsp.doc) ? dsp : undefined)
        .filter(dsp => !!dsp)
        .map(dsp => dsp!)
        .do(dsp => log(`B Validate ${dsp.doc.uri}:${dsp.doc.version}`))
        .debounce(dsp => {
            const { doc, settings } = dsp;
            if (doc.uri !== lastValidated && lastDurationSelector) {
                lastDurationSelector.next(0);
            }
            lastDurationSelector = new Rx.Subject<number>();
            Rx.Observable.timer(settings.spellCheckDelayMs || defaultDebounce).subscribe(lastDurationSelector);
            return lastDurationSelector;
        })
        .map(dsp => dsp.doc)
        .do(doc => log(`Validate: ${doc.uri}`))
        .do(() => lastDurationSelector = undefined)
        .subscribe(validateTextDocument);

    // Clear the diagnostics for documents we do not want to validate
    const disposableSkipValidationStream = validationRequestStream
        .filter(doc => !shouldValidateDocument(doc))
        .do(doc => log(`Skip Validate: ${doc.uri}`))
        .subscribe(doc => {
            connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
        });

    const disposableTriggerUpdateConfigStream = triggerUpdateConfig
        .do(() => log('Trigger Update Config'))
        .do(() => activeSettingsNeedUpdating = true)
        .debounceTime(100)
        .subscribe(() => {
            updateActiveSettings();
        });

    const disposableTriggerValidateAll = triggerValidateAll
        .debounceTime(250)
        .subscribe(() => {
            log('Validate all documents');
            documents.all().forEach(doc => validationRequestStream.next(doc));
        });

    validationFinishedStream.next({ uri: 'start', version: 0 });

    async function shouldValidateDocument(textDocument: TextDocument): Promise<boolean> {
        const { uri } = textDocument;
        const settings = await getActiveSettings(textDocument);
        return !!settings.enabled && await isLanguageEnabled(textDocument)
            && !await isUriExcluded(uri);
    }

    async function isLanguageEnabled(textDocument: TextDocumentUriLangId) {
        const { enabledLanguageIds = []} = await getActiveSettings(textDocument);
        return enabledLanguageIds.indexOf(textDocument.languageId) >= 0;
    }

    async function isUriExcluded(uri: string) {
        return documentSettings.isExcluded(uri);
    }

    async function getBaseSettings(doc: TextDocument) {
        const settings = await getActiveSettings(doc);
        return {...CSpell.mergeSettings(defaultSettings, settings), enabledLanguageIds: settings.enabledLanguageIds};
    }

    async function getSettingsToUseForDocument(doc: TextDocument) {
        return tds.constructSettingsForText(await getBaseSettings(doc), doc.getText(), doc.languageId);
    }

    async function validateTextDocument(textDocument: TextDocument): Promise<void> {
        try {
            const settingsToUse = await getSettingsToUseForDocument(textDocument);
            if (settingsToUse.enabled) {
                Validator.validateTextDocument(textDocument, settingsToUse).then(diagnostics => {
                    // Send the computed diagnostics to VSCode.
                    validationFinishedStream.next(textDocument);
                    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
                });
            }
        } catch (e) {
            console.log(e);
        }
    }

    // Make the text document manager listen on the connection
    // for open, change and close text document events
    documents.listen(connection);

    // The content of a text document has changed. This event is emitted
    // when the text document first opened or when its content has changed.
    documents.onDidChangeContent((change) => {
        validationRequestStream.next(change.document);
    });

    documents.onDidClose((event) => {
        // A text document was closed we clear the diagnostics
        connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    });

    connection.onCodeAction(onCodeActionHandler(documents, getBaseSettings));

    // Listen on the connection
    connection.listen();

    // Free up the validation streams on shutdown.
    connection.onShutdown(() => {
        disposableSkipValidationStream.unsubscribe();
        disposeValidationStream.unsubscribe();
        disposableTriggerUpdateConfigStream.unsubscribe();
        disposableTriggerValidateAll.unsubscribe();
    });
}

run();