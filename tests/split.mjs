import { splitSentences, joinText } from '../js/text.js';
const cases = [
 'Mr. Smith met Dr. Jones at 3.15 p.m. in the U.S. embassy. They talked.',
 'He lived in the U.S. He was happy.',
 '“You are late,” she said. “I was waiting.” He nodded.',
 'Is it true? Yes! It is... Maybe not.',
 'They bought apples, pears, etc. The rest was left.',
 'J. R. R. Tolkien wrote it, e.g. The Hobbit, i.e. a novel. Fine.',
 'It cost $4.50 in 1999. Prices rose.',
 'See p. 37 and No. 5 for details. Done.',
 'five altogether—Mr. Bingley, his two sisters.',
 '‘Oh! Single, my dear, to be sure!’ she cried.',
];
for (const c of cases) console.log(JSON.stringify(splitSentences(c).map(r => c.slice(r.start, r.end))));
for (const [a,b] of [['experi-','ence'],['dis -','concerted'],['well-','known'],['1914-','1918'],['London—','his'],['the end.','Next']]) console.log(a,'+',b,'=>',joinText(a,b).text);
