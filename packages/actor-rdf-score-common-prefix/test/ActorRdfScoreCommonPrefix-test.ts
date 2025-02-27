import { Bus } from '@comunica/core';
import { ActorRdfScore } from '@treecg/bus-rdf-score';
import { DataFactory } from 'rdf-data-factory';
import { ActorRdfScoreCommonPrefix } from '../lib/ActorRdfScoreCommonPrefix';

const DF = new DataFactory();

function createStringQuad(s: string, p: string, o: string) {
  return DF.quad(DF.namedNode(s), DF.namedNode(p), DF.literal(o));
}

function createLangStringQuad(s: string, p: string, o: string) {
  return DF.quad(DF.namedNode(s), DF.namedNode(p), DF.literal(o, 'en'));
}

function createNumberQuad(s: string, p: string, o: string) {
  return DF.quad(
    DF.namedNode(s),
    DF.namedNode(p),
    DF.literal(o, DF.namedNode('http://www.w3.org/2001/XMLSchema#integer')),
  );
}

function createNamedNodeQuad(s: string, p: string, o: string) {
  return DF.quad(DF.namedNode(s), DF.namedNode(p), DF.namedNode(o));
}

describe('ActorRdfResolveHypermediaLinksNext', () => {
  let bus: any;

  beforeEach(() => {
    bus = new Bus({ name: 'bus' });
  });

  describe('The ActorRdfScoreCommonPrefix module', () => {
    it('should be a function', () => {
      expect(ActorRdfScoreCommonPrefix).toBeInstanceOf(Function);
    });

    it('should be a ActorRdfScoreCommonPrefix constructor', () => {
      expect(new (<any>ActorRdfScoreCommonPrefix)({ name: 'actor', bus }))
        .toBeInstanceOf(ActorRdfScoreCommonPrefix);
      expect(new (<any>ActorRdfScoreCommonPrefix)({ name: 'actor', bus }))
        .toBeInstanceOf(ActorRdfScore);
    });

    it('should not be able to create new ActorRdfScoreCommonPrefix objects without \'new\'', () => {
      expect(() => { (<any>ActorRdfScoreCommonPrefix)(); }).toThrow();
    });
  });

  describe('An ActorRdfScoreCommonPrefix instance', () => {
    let actor: ActorRdfScoreCommonPrefix;

    beforeEach(() => {
      actor = new ActorRdfScoreCommonPrefix({ name: 'actor', bus });
    });

    it('should test on string value', () => {
      const result = actor.test({
        quad: createStringQuad('sub', 'pred', 'test'),
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'alphonse', 'meterie' ],
        },
      });
      return expect(result).resolves.toMatchObject({ suitable: true });
    });

    it('should test on lang string value', () => {
      const result = actor.test({
        quad: createLangStringQuad('sub', 'pred', 'test'),
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'alphonse', 'meterie' ],
        },
      });
      return expect(result).resolves.toMatchObject({ suitable: true });
    });

    it('should not test on integer value', () => {
      const result = actor.test({
        quad: createNumberQuad('sub', 'pred', '4'),
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'te' ],
        },
      });
      return expect(result).resolves.toMatchObject({ suitable: false });
    });

    it('should not test on non-literals', () => {
      const result = actor.test({
        quad: createNamedNodeQuad('sub', 'otherpred', 'http://example.org'),
        literalValue: [ 'anna' ],
        expectedPredicateValues: {
          pred: [ 'anna' ],
        },
      });
      return expect(result).resolves.toMatchObject({ suitable: false });
    });

    it('should match expected data type value, exact match', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'alphonse'),
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'alphonse' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 8 });
    });

    it('should prioritize explicit literal values', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'alphonse'),
        literalValue: [ 'alphonse', 'meterie' ],
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'alphonse', 'meterie' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 15 });
    });

    it('should not care about the order of values', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'alphonse'),
        literalValue: [ 'meterie', 'alphonse' ],
        expectedDatatypeValues: {
          'http://www.w3.org/2001/XMLSchema#string': [ 'alphonse', 'meterie' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 15 });
    });

    it('should match expected predicate value, exact match', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'alphonse'),
        expectedPredicateValues: {
          pred: [ 'alphonse' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 8 });
    });

    it('should not match everything', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'pablo'),
        expectedPredicateValues: {
          pred: [ 'alphonse', 'meterie' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 0 });
    });

    it('should not count occurences twice', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'de decker'),
        expectedPredicateValues: {
          pred: [ 'de' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 2 });
    });

    it('should not count occurences twice, unless explicitly expecting them twice', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'de decker'),
        literalValue: [ 'de', 'decker' ],
        expectedPredicateValues: {
          pred: [ 'de', 'de' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 4 });
    });

    it('should detect overlap correctly', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'pred', 'anne'),
        expectedPredicateValues: {
          pred: [ 'anna' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 3 });
    });

    it('should return 0 when no expected values match the quad', () => {
      const result = actor.run({
        quad: createStringQuad('sub', 'otherpred', ' Anna '),
        literalValue: 'anna',
        expectedPredicateValues: {
          pred: [ 'anna' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: 0 });
    });

    it('should return null when it wasn\'t even a literal', () => {
      const result = actor.run({
        quad: createNamedNodeQuad('sub', 'otherpred', 'http://example.org'),
        literalValue: 'anna',
        expectedPredicateValues: {
          pred: [ 'anna' ],
        },
      });
      return expect(result).resolves.toMatchObject({ score: null });
    });
  });
});
