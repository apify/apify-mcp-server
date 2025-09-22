import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsonToMarkdown } from '../../src/utils/json-to-markdown.js';

describe('jsonToMarkdown', () => {
    it('should format simple json object', () => {
        expect(jsonToMarkdown({
            name: 'John Doe',
            age: 30,
            email: 'john.doe@example.com',
        })).toMatchInlineSnapshot(`
          "name: John Doe
          age: 30
          email: john.doe@example.com"
        `);
    });

    it('should format simple json array', () => {
        expect(jsonToMarkdown([1, 2, 3])).toMatchInlineSnapshot(`"1, 2, 3"`);
        expect(jsonToMarkdown({ a: [1, 2, 3], b: [4, 5] })).toMatchInlineSnapshot(`
          "a: 1, 2, 3
          b: 4, 5"
        `);
    });

    it('should format array of other types', () => {
        expect(jsonToMarkdown([true, false, 'hello', 123, { a: 1, b: 2 }, [1, 2, 3], null])).toMatchInlineSnapshot(`
          "- true
          - false
          - hello
          - 123
          - a: 1
            b: 2
          - 1, 2, 3"
        `);
    });

    it('should format json array with nested objects', () => {
        expect(jsonToMarkdown([{ a: 1, b: 2 }, { a: 3, b: 4 }])).toMatchInlineSnapshot(`
          "- a: 1
             b: 2
          - a: 3
            b: 4"
        `);

        expect(jsonToMarkdown({ x: [{ a: 1, b: 2 }, { a: 3, b: 4 }] })).toMatchInlineSnapshot(`
            "x:
              - a: 1
                b: 2
              - a: 3
                b: 4"
          `);
    });

    it('should format json with nested objects', () => {
        expect(jsonToMarkdown({
            name: 'John Doe',
            pets: [{
                name: 'Rex',
                age: 5,
                type: 'dog',
            }, {
                name: 'Bella',
                age: 3,
                type: 'cat',
            }],
        })).toMatchInlineSnapshot(`
          "name: John Doe
          pets:
            - name: Rex
              age: 5
              type: dog
            - name: Bella
              age: 3
              type: cat"
        `);
        expect(jsonToMarkdown({ location: { lat: 40, lng: -73 } })).toMatchInlineSnapshot(`
            "location:
              lat: 40
              lng: -73"
          `);
    });

    it('should format object object array object inline', () => {
        expect(jsonToMarkdown(
            { a:
              { b: [
                  { c: 1 },
              ] } },
        )).toMatchInlineSnapshot(`"a: b: - c: 1"`);
    });

    it('should format object object array object multiline', () => {
        expect(jsonToMarkdown(
            { a:
              { b: [
                  { c: 1 },
                  { d: 2 },
              ] } },
        )).toMatchInlineSnapshot(`
          "a:
            b:
              - c: 1
              - d: 2"
        `);
    });

    it('should simplify object with single property true', () => {
        expect(jsonToMarkdown(
            { additionalInfo:
            { Service_options: [
                { Outdoor_seating: true },
            ] } },
        )).toMatchInlineSnapshot('"additionalInfo: Service_options: Outdoor_seating"');
        expect(jsonToMarkdown(
            { additionalInfo:
          { Service_options: [
              { Outdoor_seating: true },
              { Delivery: true },
          ] } },
        )).toMatchInlineSnapshot(`"additionalInfo: Service_options: Outdoor_seating, Delivery"`);
    });

    it('should format real Google Maps dataset item', () => {
        const jsonString = readFileSync(path.join(__dirname,
            'dataset_google-maps-extractor_2025-09-19_16-26-25-793.json'), 'utf8');
        const json = JSON.parse(jsonString);
        const result = jsonToMarkdown(json);
        expect(result).toMatchSnapshot();
    });
});
