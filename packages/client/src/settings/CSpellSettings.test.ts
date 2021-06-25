import { readSettings, writeSettings } from './CSpellSettings';
import * as CSS from './CSpellSettings';
import { unique } from '../util';
import { CSpellUserSettings } from '.';
import { Uri } from 'vscode';
import { fsRemove, getPathToTemp, getUriToSample, writeFile, readFile, mkdirp } from '../test/helpers';

describe('Validate CSpellSettings functions', () => {
    const filenameSampleCSpellFile = getUriToSample('cSpell.json');

    beforeAll(() => {
        return fsRemove(getPathToTemp('.'));
    });

    test('tests reading a settings file', async () => {
        const settings = await readSettings(filenameSampleCSpellFile);
        expect(Object.keys(settings)).not.toHaveLength(0);
        expect(settings.enabled).toBeUndefined();
        expect(settings.enabledLanguageIds).toBeUndefined();
    });

    test('reading a file that does not exist', async () => {
        const pSettings = CSS.readRawSettingsFile(getUriToSample('not_found/cspell.json'));
        await expect(pSettings).resolves.toBeUndefined();
    });

    test('reading a settings file that does not exist results in default', async () => {
        const pSettings = CSS.readSettings(getUriToSample('not_found/cspell.json'));
        await expect(pSettings).resolves.toBe(CSS.getDefaultSettings());
    });

    test('tests writing a file', async () => {
        const filename = getPathToTemp('dir1/tempCSpell.json');
        const settings = await readSettings(filenameSampleCSpellFile);
        settings.enabled = false;
        await writeSettings(filename, settings);
        const writtenSettings = await readSettings(filename);
        expect(writtenSettings).toEqual(settings);
    });

    test('tests writing an unsupported file format', async () => {
        const filename = getPathToTemp('tempCSpell.js');
        await writeFile(filename, sampleJSConfig);
        const r = CSS.readSettingsFileAndApplyUpdate(filename, (s) => s);
        await expect(r).rejects.toBeInstanceOf(CSS.FailedToUpdateConfigFile);
    });

    test('addWordToSettingsAndUpdate', async () => {
        const word = 'word';
        const filename = getPathToTemp('addWordToSettingsAndUpdate/cspell.json');
        await writeFile(filename, sampleJsonConfig);
        const r = await CSS.addWordsToSettingsAndUpdate(filename, word);
        expect(r.words).toEqual(expect.arrayContaining([word]));
        expect(await readSettings(filename)).toEqual(r);
    });

    test('addIgnoreWordToSettingsAndUpdate', async () => {
        const word = 'word';
        const filename = getPathToTemp('addIgnoreWordToSettingsAndUpdate/cspell.json');
        await writeFile(filename, sampleJsonConfig);
        const r = await CSS.addIgnoreWordToSettingsAndUpdate(filename, word);
        expect(r.ignoreWords).toEqual(expect.arrayContaining([word]));
        expect(await readSettings(filename)).toEqual(r);
    });

    test('Validate default settings', () => {
        const defaultSetting = CSS.getDefaultSettings();
        expect(defaultSetting.words).toBeUndefined();
        expect(defaultSetting.version).toBe('0.2');
    });

    test('tests adding words', () => {
        const words = ['test', 'case', 'case'];
        const defaultSettings = CSS.getDefaultSettings();
        Object.freeze(defaultSettings);
        const newSettings = CSS.addWordsToSettings(defaultSettings, words);
        expect(newSettings).not.toBe(defaultSettings);
        expect(newSettings.words).not.toHaveLength(0);
        expect(newSettings.words?.sort()).toEqual(unique(words).sort());
    });

    test('tests adding languageIds', () => {
        const ids = ['cpp', 'cs', 'php', 'json', 'cs'];
        const defaultSettings = CSS.getDefaultSettings();
        Object.freeze(defaultSettings);
        expect(defaultSettings.enabledLanguageIds).toBeUndefined();
        const s1 = CSS.addLanguageIdsToSettings(defaultSettings, ids, true);
        expect(s1.enabledLanguageIds).toBeUndefined();
        const s2 = CSS.addLanguageIdsToSettings(defaultSettings, ids, false);
        expect(s2.enabledLanguageIds).not.toHaveLength(0);
        expect(s2.enabledLanguageIds!.sort()).toEqual(unique(ids).sort());
    });

    test('tests removing languageIds', () => {
        const ids = ['cpp', 'cs', 'php', 'json', 'cs'];
        const toRemove = ['cs', 'php', 'php'];
        const expected = ['cpp', 'json'];
        const defaultSettings = CSS.getDefaultSettings();
        expect(defaultSettings.enabledLanguageIds).toBeUndefined();
        const s2 = CSS.addLanguageIdsToSettings(defaultSettings, ids, false);
        Object.freeze(s2);
        expect(s2.enabledLanguageIds).not.toHaveLength(0);
        expect(s2.enabledLanguageIds!.sort()).toEqual(unique(ids).sort());
        const s3 = CSS.removeLanguageIdsFromSettings(s2, toRemove);
        expect(s3.enabledLanguageIds).not.toHaveLength(0);
        expect(s3.enabledLanguageIds!.sort()).toEqual(expected);
        const s4 = CSS.removeLanguageIdsFromSettings(defaultSettings, toRemove);
        expect(s4.enabledLanguageIds).toBeUndefined();
        const s5 = CSS.removeLanguageIdsFromSettings(s2, ids);
        expect(s5.enabledLanguageIds).toBeUndefined();
    });

    test('tests removing words from the settings', () => {
        const defaultSettings = CSS.getDefaultSettings();
        const settings: CSpellUserSettings = { ...defaultSettings, words: ['apple', 'banana', 'orange', 'blue', 'green', 'red', 'Yellow'] };
        Object.freeze(settings);
        const result = CSS.removeWordsFromSettings(settings, ['BLUE', 'pink', 'yellow']);
        expect(result.words).toEqual(['apple', 'banana', 'orange', 'green', 'red']);
    });

    test.each`
        uri                               | expected
        ${''}                             | ${false}
        ${'file:///x/cspell.yml'}         | ${false}
        ${'file:///x/cspell.config.js'}   | ${false}
        ${'file:///x/cspell.config.cjs'}  | ${false}
        ${'file:///x/cspell.json'}        | ${true}
        ${'file:///x/cspell.json?q=a'}    | ${true}
        ${'file:///x/cspell.jsonc?q=a#f'} | ${true}
        ${'file:///x/cspell.jsonc#f'}     | ${true}
    `('isSupportedConfigFileFormat $uri', ({ uri, expected }: { uri: string; expected: boolean }) => {
        const uriCfg = Uri.parse(uri);
        expect(CSS.isUpdateSupportedForConfigFileFormat(uriCfg)).toBe(expected);
    });

    test('addWordsToCustomDictionary', async () => {
        const dictUri = getPathToTemp('addWordsToCustomDictionary/dict.txt');
        const words1 = ['one', 'two', 'three'];
        const words2 = ['alpha', 'beta', 'delta', 'zeta', 'one'];
        const expected = [...['alpha', 'beta', 'delta', 'zeta', 'one', 'two', 'three'].sort(), ''].join('\n');
        await expect(CSS.addWordsToCustomDictionary(words1, dictUri)).resolves.toBeUndefined();
        expect(readFile(dictUri)).resolves.toBe([...words1].sort().join('\n') + '\n');
        await expect(CSS.addWordsToCustomDictionary(words2, dictUri)).resolves.toBeUndefined();
        expect(readFile(dictUri)).resolves.toBe(expected);
    });

    test.each`
        file              | error
        ${''}             | ${e(sm(/Failed to add words to dictionary .*, unsupported format./))}
        ${'words.txt.gz'} | ${e(sm(/words.txt.gz.*unsupported format./))}
        ${'cspell.json'}  | ${e(sm(/cspell.json.*unsupported format./))}
    `('addWordsToCustomDictionary_failures $file', async ({ file, error }) => {
        const pathUri = getPathToTemp('addWordsToCustomDictionary_failures');
        await mkdirp(pathUri);
        const dictUri = Uri.joinPath(pathUri, file);
        const words = ['one', 'two', 'three'];
        await expect(CSS.addWordsToCustomDictionary(words, dictUri)).rejects.toEqual(error);
    });

    test.each`
        file           | error
        ${'words.txt'} | ${e(sm(/Failed to add words to dictionary.*EISDIR/))}
    `('addWordsToCustomDictionary_cannot_write $file', async ({ file, error }) => {
        const pathUri = getPathToTemp('addWordsToCustomDictionary_cannot_write');
        const dictUri = Uri.joinPath(pathUri, file);
        // Make the file into a directory to force the error.
        await mkdirp(dictUri);
        const words = ['one', 'two', 'three'];
        await expect(CSS.addWordsToCustomDictionary(words, dictUri)).rejects.toEqual(error);
    });
});

function oc(...args: Parameters<typeof expect.objectContaining>) {
    return expect.objectContaining(...args);
}

function sm(...args: Parameters<typeof expect.stringMatching>) {
    return expect.stringMatching(...args);
}

function e(message: string) {
    return oc({
        message,
    });
}

const sampleJSConfig = `
module.exports = {
    version: "0.2",
    words: [],
}
`;

const sampleConfig: CSpellUserSettings = {
    version: '0.2',
    description: 'Sample Test Config',
    import: [],
};

const sampleJsonConfig = JSON.stringify(sampleConfig, undefined, 2);
