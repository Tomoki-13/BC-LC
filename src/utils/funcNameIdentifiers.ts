//変数の呼び出した際の名前を取得
export const funcNameIdentifiers = (line: string, libraryName: string): string[] => {
  const pattern1: RegExp = new RegExp(`import\\s+(\\w+)\\s+from\\s+\\(*['"\`]${libraryName}[^-]*?['"\`]\\)*`);
  //_interopRequireDefault()を含む
  const pattern2: RegExp = new RegExp(`(?:var|const|let)*\\s*(\\w+)\\s*=\\s*require\\s*\\(\\s*['"\`]\\s*${libraryName}[^-]*?['"\`]\\s*\\)*`);
  const pattern3: RegExp = new RegExp(`import\\s*{\\s*([^}]+)\\s*}\\s*from\\s+\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);
  const pattern4: RegExp = new RegExp(`import\\s*\\*\\s+as\\s+(\\w+)\\s+from\\s+\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);
  const pattern5: RegExp = new RegExp(`(?:var|const|let)\\s*{\\s*([^\\s]+)\\s*}\\s*=\\s*require\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*.*$`);
  const pattern6: RegExp = new RegExp(`(?:var|const|let)\\s*{\\s*([^}]+)\\s*}\\s*=\\s*require\\(*\\s*['"\`]\\s*${libraryName}[^-]*?\\s*['"\`]\\s*\\)*`);

  const match1: RegExpMatchArray | null = line.match(pattern1);
  const match2: RegExpMatchArray | null = line.match(pattern2);
  const match3: RegExpMatchArray | null = line.match(pattern3);

  const match4: RegExpMatchArray | null = line.match(pattern4);
  const match5: RegExpMatchArray | null = line.match(pattern5);
  const match6: RegExpMatchArray | null = line.match(pattern6);
  let match3_1: string[] = [];
  let match6_1: string[] = [];
  //match3の{}の中を処理
  if (match3) {
    const resultArray: string[] = match3[1].split(',').map(item => item.trim());
    const AsPattern: RegExp = /(.+?)\s+as\s+([^\s]+)/;
    for (const result of resultArray) {
      const name: string[] | null = result.match(AsPattern);
      if (name != null) {
        match3_1.push(name[2]);
      } else {
        match3_1.push(result);
      }
    }
  }

  if (match6) {
    const resultArray = match6[1].split(',').map(item => item.trim());
    const AsPattern: RegExp = /[^:]+:\s*([^,\s]+)/;
    for (const result of resultArray) {
      const name = result.match(AsPattern);
      if (name != null) {
        match6_1.push(name[1]);
      } else {
        match6_1.push(result);
      }
    }
  }
  if (match1) {
    let result: string[] = [];
    result.push(match1[1].trim());
    return result;
  } else if (match2) {
    let result: string[] = [];
    result.push(match2[1].trim());
    return result;
  } else if (match3_1 != null && match3_1.length > 0) {
    if (match3_1.length == 1) {
      let result: string[] = [];
      result.push(match3_1[0].trim());
      return result;
    }
    return match3_1;
  } else if (match4) {
    let result: string[] = [];
    result.push(match4[1].trim());
    return result;
  } else if (match6_1 != null && match6_1.length > 0) {
    if (match6_1.length == 1) {
      let result: string[] = [];
      result.push(match6_1[0].trim());
      return result;
    }
    return match6_1;
  } else if (match5) {
    let result: string[] = [];
    result.push(match5[1].trim());
    return result;
  } else {
    return [];
  }
}

export const secfuncNameIdentifiers = (functionName: string, line: string): string[] => {
  const pattern1: RegExp = new RegExp(`(?:var|const|let)\\s*(\\w+)\\s*=\\s*_interopRequireDefault\\(\\s*${functionName}[^-]*?\\s*\\)*`);
  const pattern2: RegExp = new RegExp(`(?:var|const|let)\\s*\\{\\s*([^\\s]+)\\s*\\}\\s*=\\s*_interopRequireDefault\\(\\s*${functionName}[^-]*?\\s*\\)*`);
  const match1: RegExpMatchArray | null = line.match(pattern1);
  const match2: RegExpMatchArray | null = line.match(pattern2);
  let secFuncName: string[] = [];
  let match2_1: string[] = [];
  if (match2) {
    const resultArray: string[] = match2[1].split(',').map(item => item.trim());
    const AsPattern: RegExp = /([^:\s]+):\s*([^,\s]+)/;
    for (const result of resultArray) {
      const name: RegExpMatchArray | null = result.match(AsPattern);
      if (name != null) {
        match2_1.push(name[2]);
      } else {
        match2_1.push(result);
      }
    }
  }
  if (match1) {
    secFuncName.push(match1[1]);
  } else if (match2) {
    if (match2_1.length > 0) {
      secFuncName = secFuncName.concat(match2_1);
    }
  }
  return secFuncName;
}