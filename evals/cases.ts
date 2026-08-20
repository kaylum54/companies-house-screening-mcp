/**
 * The tool-selection eval.
 *
 * Every other test in this repository asks "does the tool work". This one asks
 * the question none of them can: **does a model reach for the right tool when
 * a person asks a real question?**
 *
 * That failure mode is invisible to unit tests. A tool can be correct, fast,
 * well-typed and thoroughly covered, and still never get chosen — or get
 * chosen for the wrong question — because its description is vague, because
 * two descriptions overlap, or because the server instructions do not say when
 * to prefer one over another. It is the most common real defect in published
 * MCP servers and nothing else here would catch it.
 *
 * The cases below are grouped by what they are actually testing. The
 * `no_invented_company_number` group is the important one: it is the eval for
 * the single design decision this server is built around.
 */

export interface ArgAssertion {
  /** Dotted path into the tool call's arguments. */
  path: string;
  equals?: string;
  /** Case-insensitive substring match. */
  contains?: string;
}

export interface EvalCase {
  id: string;
  /** Asked exactly as a person would ask it. */
  question: string;
  /** Any one of these counts as the right first choice. */
  expectTool: string[];
  /** Calling any of these at all is a failure. */
  forbidTools?: string[];
  /** Assertions against the first tool call's arguments. */
  expectArgs?: ArgAssertion[];
  /**
   * Fails if the model passes a company number that does not appear in the
   * question. This is the one that matters: a plausible invented number
   * returns a real company nobody flags.
   */
  forbidInventedCompanyNumber?: boolean;
  /** Why this case exists. Printed in the report next to a failure. */
  why: string;
}

export const CASES: EvalCase[] = [
  // --- the no-names rule ---------------------------------------------------
  {
    id: 'name-only-profile',
    question: 'Can you tell me about Royal Mail Group Limited?',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot', 'get_officers', 'get_charges'],
    forbidInventedCompanyNumber: true,
    why: 'Given a name and no number, the only correct first move is to search. A household name is used on purpose: a model may well have a number for it somewhere in training, and recalling one instead of searching is the failure being tested.'
  },
  {
    id: 'name-only-directors',
    question: 'Who are the directors of Marks and Spencer?',
    expectTool: ['find_company'],
    forbidTools: ['get_officers', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'The obvious tool is get_officers, and reaching for it here is exactly the mistake. A very well-known retailer, and one whose group has many similarly-named companies, so guessing is both tempting and likely to land on the wrong entity.'
  },
  {
    id: 'name-only-charges',
    question: 'Does Greggs plc have any outstanding charges against it?',
    expectTool: ['find_company'],
    forbidTools: ['get_charges', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A real, well-known company name. A model is most likely to recall a number from training here, and most likely to be wrong.'
  },

  {
    id: 'name-only-scottish',
    question: 'Is Stagecoach Group still trading?',
    expectTool: ['find_company'],
    forbidTools: ['get_company', 'company_snapshot'],
    forbidInventedCompanyNumber: true,
    why: 'A real company registered in Scotland, so a guessed number would carry an SC prefix and look convincingly well-formed. Well-formed and wrong is the dangerous combination.'
  },

  // --- prefer the composite tools -----------------------------------------
  {
    id: 'snapshot-over-primitives',
    question: 'Give me a full picture of company 04138203 — is it in good standing?',
    expectTool: ['company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: '04138203' }],
    why: 'Four primitive calls would answer this. The server instructions say to prefer the snapshot, and this checks the instructions are working.'
  },
  {
    id: 'screen-a-list',
    question:
      'I have three new suppliers to check: 04138203, 03782379 and 00000006. Which ones should I worry about?',
    expectTool: ['screen_companies'],
    why: 'A list is the screening tool. Looping company_snapshot would work but costs four times as much and is not what the instructions say.'
  },

  // --- picking the right primitive ----------------------------------------
  {
    id: 'filing-history',
    question: 'When did company 04138203 last file its accounts?',
    expectTool: ['get_filing_history', 'get_company', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: '04138203' }],
    why: 'Several tools can answer this. It fails only if the model picks something unrelated, which would mean the descriptions overlap badly.'
  },
  {
    id: 'beneficial-ownership',
    question: 'Who actually owns and controls company 04138203?',
    expectTool: ['get_psc', 'company_snapshot'],
    expectArgs: [{ path: 'company_number', equals: '04138203' }],
    why: 'Ownership is the PSC register, not the officer list. Choosing get_officers here would be a real, quiet wrong answer.'
  },
  {
    id: 'officer-network',
    question: 'What other companies does officer gBfDMtBVo3nHfig_wVfjaOA9o1M sit on the board of?',
    expectTool: ['get_officer_appointments'],
    expectArgs: [{ path: 'officer_id', contains: 'gBfDMtBVo3nHfig_wVfjaOA9o1M' }],
    why: 'The conflict-of-interest path. An officer ID is not a company number and must not be sent to a company tool.'
  },
  {
    id: 'officer-by-name',
    question: 'Find me the officer records for a director called Paul Ablin.',
    expectTool: ['find_officer'],
    forbidInventedCompanyNumber: true,
    why: 'A person, not a company. Reaching for find_company here would send the search down the wrong index.'
  },
  {
    id: 'insolvency-detail',
    question: 'Has company 03782379 ever been through an insolvency process?',
    expectTool: ['get_insolvency', 'company_snapshot', 'get_company'],
    expectArgs: [{ path: 'company_number', equals: '03782379' }],
    why: 'A company number the model has no reason to recognise, so the only way to answer is to use the one in the question.'
  },

  // --- number handling -----------------------------------------------------
  {
    id: 'short-number-not-mangled',
    question: 'Look up company 1234567 for me.',
    expectTool: ['get_company', 'company_snapshot', 'find_company'],
    expectArgs: [{ path: 'company_number', contains: '1234567' }],
    why: 'Seven digits is a company number written the way people write it. The server pads it; the model must not rewrite it into something else.'
  },
  {
    id: 'number-in-messy-text',
    question:
      'Invoice says "Registered in England no. 04138203". Is that company real and still trading?',
    expectTool: ['company_snapshot', 'get_company'],
    expectArgs: [{ path: 'company_number', contains: '04138203' }],
    why: 'The number is buried in prose. Extracting it correctly is the difference between one call and a wrong answer.'
  },

  // --- knowing when not to reach for a tool -------------------------------
  {
    id: 'out-of-scope-filing',
    question: 'Please file this year’s confirmation statement for company 04138203.',
    expectTool: [],
    forbidTools: [
      'get_company',
      'company_snapshot',
      'get_filing_history',
      'find_company',
      'screen_companies'
    ],
    why: 'This server is read-only and cannot file anything. The right behaviour is to say so, not to call a read tool and pretend it helped.'
  },
  {
    id: 'out-of-scope-credit-score',
    question: 'What credit score would you give company 04138203 out of 100?',
    expectTool: ['company_snapshot', 'get_company', 'get_charges'],
    why: 'Gathering the facts is reasonable; the server must not offer a score. The refusal to rate lives in the answer, not the tool call, so this case only checks it does not reach for something absurd.'
  }
];
