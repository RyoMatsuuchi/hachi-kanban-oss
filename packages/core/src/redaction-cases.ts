export interface RedactionCase {
  /** `${structure}/${keyForm}/${keyName}/${valueShape}` 形の識別子。 */
  id: string;
  input: string;
  /** 出力に 1 文字も残してはならない目印文字列。 */
  secrets: readonly string[];
  /** JSON.parse に成功する入力か。 */
  parsesAsJson: boolean;
}

const KEY_NAMES = ["api_key", "authorization", "password", "database_url"] as const;
const KEY_FORMS = ["bare", "quoted"] as const;
const STRUCTURES = [
  "validJson",
  "brokenJson",
  "freeText",
  "stdoutPrefixedBrokenJson",
  "alreadyStructuredSerializedJson",
  "secretInObjectKeyJson",
] as const;
const VALUE_SHAPES = [
  "plain",
  "escapedQuote",
  "commaContinuation",
  "urlUserinfo",
  "recognizedSecretAndUrlUserinfo",
  "alreadyRedactedPrefix",
] as const;

type KeyName = typeof KEY_NAMES[number];
type KeyForm = typeof KEY_FORMS[number];
type Structure = typeof STRUCTURES[number];
type ValueShape = typeof VALUE_SHAPES[number];

interface ValueFixture {
  logicalValue: string;
  freeTextValue: string;
  secrets: readonly string[];
}

function generateValueFixture(
  keyName: KeyName,
  valueShape: ValueShape,
  caseNumber: number,
): ValueFixture {
  const marker = `marker-${String(caseNumber).padStart(3, "0")}-alpha`;
  const continuationMarker = `marker-${String(caseNumber).padStart(3, "0")}-beta`;
  const authorizationPrefix = keyName === "authorization" && valueShape !== "alreadyRedactedPrefix"
    ? "Basic "
    : "";

  switch (valueShape) {
    case "plain": {
      const logicalValue = `${authorizationPrefix}${marker}`;
      return { logicalValue, freeTextValue: logicalValue, secrets: [marker] };
    }
    case "escapedQuote": {
      const logicalValue = `${authorizationPrefix}${marker}"${continuationMarker}`;
      return {
        logicalValue,
        freeTextValue: JSON.stringify(logicalValue),
        secrets: [marker, continuationMarker],
      };
    }
    case "commaContinuation": {
      const logicalValue = `${authorizationPrefix}${marker}, "next": "${continuationMarker}"`;
      return {
        logicalValue,
        freeTextValue: `"${authorizationPrefix}${marker}", "next": "${continuationMarker}"`,
        secrets: [marker, continuationMarker],
      };
    }
    case "urlUserinfo": {
      const logicalValue = `${authorizationPrefix}scheme://${marker}:${continuationMarker}@host.example/path`;
      return { logicalValue, freeTextValue: logicalValue, secrets: [marker, continuationMarker] };
    }
    case "recognizedSecretAndUrlUserinfo": {
      const logicalValue = `${authorizationPrefix}sk-live-${marker} scheme://${marker}:${continuationMarker}@host.example/path`;
      return { logicalValue, freeTextValue: logicalValue, secrets: [marker, continuationMarker] };
    }
    case "alreadyRedactedPrefix": {
      const logicalValue = `[REDACTED]${marker}`;
      return { logicalValue, freeTextValue: logicalValue, secrets: [marker] };
    }
  }
}

function assignmentPrefix(keyName: KeyName, keyForm: KeyForm): string {
  return keyForm === "quoted" ? `"${keyName}":` : `${keyName}=`;
}

function generateCase(
  structure: Structure,
  keyForm: KeyForm,
  keyName: KeyName,
  valueShape: ValueShape,
  caseNumber: number,
): RedactionCase {
  const id = `${structure}/${keyForm}/${keyName}/${valueShape}`;

  const fixture = generateValueFixture(keyName, valueShape, caseNumber);

  if (structure === "secretInObjectKeyJson") {
    const secretKey = fixture.secrets.reduce(
      (key, secret) => key.replaceAll(secret, `sk-${secret}`),
      fixture.logicalValue,
    );
    return {
      id,
      input: JSON.stringify({
        nested: {
          [`${secretKey}-${keyName}`]: "public-value",
          publicSibling: "preserved",
        },
      }),
      secrets: fixture.secrets,
      parsesAsJson: true,
    };
  }

  if (structure === "validJson" || structure === "alreadyStructuredSerializedJson") {
    return {
      id,
      input: JSON.stringify({
        ...(structure === "alreadyStructuredSerializedJson"
          ? { alreadyStructured: "[REDACTED]" }
          : {}),
        nested: { [keyName]: fixture.logicalValue },
      }),
      secrets: fixture.secrets,
      parsesAsJson: true,
    };
  }

  let input: string;
  let secrets = fixture.secrets;

  if (structure === "stdoutPrefixedBrokenJson" && keyForm === "quoted") {
    const trailingSecret = `marker-${String(caseNumber).padStart(3, "0")}-trailing`;
    input = JSON.stringify({
      nested: {
        [keyName]: fixture.logicalValue,
        next: trailingSecret,
      },
    });
    secrets = [...fixture.secrets, trailingSecret];
  } else {
    const prefix = assignmentPrefix(keyName, keyForm);
    input = structure === "brokenJson" || structure === "stdoutPrefixedBrokenJson"
      ? `{"nested":{${prefix}${fixture.freeTextValue}`
      : `記録 ${prefix}${fixture.freeTextValue} 後続の散文`;
  }

  return {
    id,
    input: structure === "stdoutPrefixedBrokenJson" ? `stdout: ${input}` : input,
    secrets,
    parsesAsJson: false,
  };
}

/** §79.5 の成立する 4 軸の直積から redaction ケースを生成する。 */
export function generateRedactionCases(): readonly RedactionCase[] {
  const cases: RedactionCase[] = [];
  let caseNumber = 0;

  for (const structure of STRUCTURES) {
    for (const keyForm of KEY_FORMS) {
      if (
        (
          structure === "validJson" ||
          structure === "alreadyStructuredSerializedJson" ||
          structure === "secretInObjectKeyJson"
        ) &&
        keyForm === "bare"
      ) continue;
      for (const keyName of KEY_NAMES) {
        for (const valueShape of VALUE_SHAPES) {
          caseNumber += 1;
          cases.push(generateCase(structure, keyForm, keyName, valueShape, caseNumber));
        }
      }
    }
  }

  return cases;
}
