import type { IActionRdfDereference } from '@comunica/bus-rdf-dereference';
import type { IActorRdfMetadataOutput } from '@comunica/bus-rdf-metadata';
import type { IActorRdfParseOutput } from '@comunica/bus-rdf-parse';
import type { IActionRdfScore, IExpectedValues, RDFScore } from '@treecg/bus-rdf-score';
import type { TreeValues } from '@treecg/bus-tree-score';
import { AsyncIterator } from 'asynciterator';
import type * as RDF from 'rdf-js';
import assignValueToLink from './functions/assignValueToLink';
import compareResults from './functions/compareResults';
import extractTreeNodes from './functions/extractTreeNodes';
import mergeScores from './functions/mergeScores';
import type IMediators from './interfaces/IMediators';
import type IRankedSubject from './interfaces/IRankedSubject';
import type IResult from './interfaces/IResult';
import type ITreeNode from './interfaces/ITreeNode';
import TreeNodeQueue from './TreeNodeQueue';

export default class ResultsIterator extends AsyncIterator<IResult> {
  protected numResults: number;
  protected mediators: IMediators;
  protected inTransit: number;
  protected queue: TreeNodeQueue;
  protected expectedTreeValues: TreeValues;
  protected expectedDatatypeValues: IExpectedValues;
  protected expectedPredicateValues: IExpectedValues;
  protected latest: IResult;
  protected ready: boolean;

  // All the results that are ready to be read
  protected buffer: IResult[];
  protected knownTreeNodes: Record<string, ITreeNode>;
  // Avoid cyclic traversals
  protected visitedTreeNodes: Set<string>;

  public constructor(
    numResults: number,
    nodes: ITreeNode[],
    mediators: IMediators,
    expectedTreeValues: TreeValues,
    expectedDatatypeValues: IExpectedValues,
    expectedPredicateValues: IExpectedValues,
  ) {
    super();

    this.numResults = numResults;
    this.mediators = mediators;
    this.expectedTreeValues = expectedTreeValues;
    this.expectedDatatypeValues = expectedDatatypeValues;
    this.expectedPredicateValues = expectedPredicateValues;
    this.inTransit = 0;
    this.queue = new TreeNodeQueue();

    this.visitedTreeNodes = new Set();
    this.buffer = [];
    this.latest = {
      subjects: new Set(),
      knownTreeNodes: nodes,
      rankedSubjects: [],
    };

    // Can't read while the queue is being populated
    this.readable = false;
    this.ready = false;

    // Not all URLs have to come from tree nodes
    // The constructor is just a special case
    const urls = [];

    const treeNodes: Record<string, ITreeNode> = {};
    this.knownTreeNodes = {};
    // Make the tree nodes indexable
    for (const node of nodes) {
      urls.push(node.url);
      treeNodes[node.url] = node;

      if (Object.keys(node.values).length > 0) {
        this.knownTreeNodes[node.url] = node;
      }
    }

    // After populating the queue, broadcast that we are ready to emit data
    this.populateQueue({}, urls, treeNodes)
      .then(() => {
        this.ready = true;
        this.readable = true;
      })
      .catch(error => {
        throw error;
      });
  }

  public async populateQueue(
    currentValue: TreeValues,
    urls: string[],
    treeNodes: Record<string, ITreeNode>,
  ): Promise<void> {
    for (const childNode of urls) {
      const values = assignValueToLink(childNode, currentValue, treeNodes);
      let { score: treeScore } = await this.mediators.mediatorTreeScore.mediate({
        values,
        expectedValues: this.expectedTreeValues,
      });

      if (!Array.isArray(treeScore)) {
        treeScore = [ treeScore ];
      }

      if (Object.keys(values).length > 0) {
        const sum = treeScore.reduce((acc, cur) => acc + cur, 0);
        if (sum > 0) {
          this.queue.push(treeScore, childNode, values);
        }
      } else {
        this.queue.push(treeScore, childNode, values);
      }
    }
  }

  public read(): IResult | null {
    if (this.closed) {
      return null;
    }

    if (!this.ready) {
      // The queue is still being initialized
      this.readable = false;
      return null;
    }

    if (this.buffer.length === 0) {
      // There are no results at the moment
      this.readable = false;
      this.scheduleRequests();
      return null;
    }

    // Always exists, we already checked the length
    const result: IResult = this.buffer.pop()!;

    return result;
  }

  protected scheduleRequests(): void {
    if (this.closed) {
      // The consumer can signal it no longer cares
      return;
    }

    if (this.queue.size() === 0) {
      // Nothing left to schedule

      if (this.inTransit === 0) {
        if (this.buffer.length === 0) {
          // Nothing left to read either
          this.close();
        } else {
          // Probably unnecessary, just making sure consumers know there's some final data
          this.readable = true;
        }
      }

      return;
    }

    const url = this.queue.pop();
    if (this.visitedTreeNodes.has(url)) {
      return;
    }
    this.visitedTreeNodes.add(url);
    this.inTransit += 1;
    this.processUrl(url)
      .then(result => {
        // Add next result to front of the queue
        this.buffer.unshift(result);
        this.readable = true;
        this.inTransit -= 1;

        // Immediately start processing the next item on the queue
        if (this.inTransit < 1) {
          this.scheduleRequests();
        }
      })
      .catch(error => {
        throw error;
      });
  }

  protected async processUrl(url: string): Promise<IResult> {
    const dereference: IActionRdfDereference = {
      url,
    };

    const rdfDereferenceOutput: IActorRdfParseOutput = await this.mediators.mediatorRdfDereference.mediate(dereference);
    // Determine the metadata
    const rdfMetadataOuput: IActorRdfMetadataOutput = await this.mediators.mediatorMetadata.mediate(
      { url, quads: rdfDereferenceOutput.quads, triples: rdfDereferenceOutput.triples },
    );
    if (this.closed) {
      // The next step can be expensive, see if we can abort
      return this.latest;
    }
    const { metadata } = await this.mediators.mediatorMetadataExtract
      .mediate({ url, metadata: rdfMetadataOuput.metadata });
    const treeNodes = extractTreeNodes(metadata);
    const { urls } = await this.mediators.mediatorHypermediaLinks.mediate({ metadata });
    // TODO, propagate tree values
    await this.populateQueue({}, <string[]>urls, treeNodes);
    // Keep track of all known tree nodes for future queries
    this.knownTreeNodes = { ...this.knownTreeNodes, ...treeNodes };
    return this.processPageData(
      rdfMetadataOuput.data,
      this.expectedDatatypeValues,
      this.expectedPredicateValues,
    );
  }

  protected processPageData(
    quadStream: RDF.Stream,
    expectedDatatypeValues: IExpectedValues,
    expectedPredicateValues: IExpectedValues,
  ): Promise<IResult> {
    let rankedSubjects: IRankedSubject[] = [];

    const store: Record<string, RDF.Quad[]> = {};
    quadStream
      .on('data', (quad: RDF.Quad) => {
        if (quad.subject.termType === 'NamedNode') {
          const subject = quad.subject.value;
          if (!(subject in store)) {
            store[subject] = [];
          }
          store[subject].push(quad);
        }
      });

    const result: Promise<IResult> = new Promise(resolve => {
      quadStream.on('end', async() => {
        for (const [ subject, quads ] of Object.entries(store)) {
          if (this.latest.subjects.has(subject)) {
            // No need to reevaluate this one
            continue;
          }
          this.latest.subjects.add(subject);

          let score: RDFScore[] = [];
          const matchingQuads = [];
          for (const quad of quads) {
            const rightPredicate = quad.predicate.value in expectedPredicateValues;
            const rightDatatype = quad.object.termType === 'Literal' &&
              (quad.object.datatype.value in expectedDatatypeValues);
            if (!rightPredicate && !rightDatatype) {
              // This is't the quad we're looking for
              continue;
            }

            const action: IActionRdfScore<any> = {
              quad,
              expectedDatatypeValues,
              expectedPredicateValues,
            };

            try {
              const literalValue = await this.mediators.mediatorLiteralNormalize.mediate({ data: quad });
              action.literalValue = literalValue.result;
            } catch {
              // Is ok
            }

            let { score: quadScore } = await this.mediators.mediatorRdfScore.mediate(action);
            if (!Array.isArray(quadScore)) {
              // Most useful mediators will return an array, but no guarantees
              quadScore = [ quadScore ];
            }

            if (!quadScore.includes(Number.NEGATIVE_INFINITY)) {
              if (quadScore.every(element => element === null)) {
                // None of the sorting actors had anything to say
                continue;
              }
              matchingQuads.push(quad);

              // -Inf indicates the score is too bad to be used
              if (score.length === 0) {
                // First valid score for this subject
                score = quadScore;
              } else {
                score = mergeScores(score, quadScore);
              }
            }
          }

          if (
            score.length > 0 &&
            !score.includes(null) &&
            !score.includes(Number.NEGATIVE_INFINITY)
          ) {
            const cast: number[] = <number[]>score;
            rankedSubjects.push({
              score: cast,
              subject,
              matchingQuads,
              quads,
            });
          }
        }

        rankedSubjects = [ ...rankedSubjects, ...this.latest.rankedSubjects ];
        rankedSubjects.sort(compareResults);
        this.latest = {
          subjects: this.latest.subjects,
          knownTreeNodes: Object.values(this.knownTreeNodes),
          rankedSubjects: rankedSubjects.slice(0, this.numResults),
        };
        resolve(this.latest);
      });
    });

    return result;
  }
}
