// Самые частые пароли по открытым спискам утечек (RockYou и производные) — сравнение без учёта
// регистра. Не претендует на полноту, задача — отсечь совсем очевидные варианты, а не заменить
// длину/сложность.
const COMMON_PASSWORDS = [
  '123456', '123456789', 'qwerty', 'password', '12345', '12345678', '111111', '1234567',
  '123123', 'qwerty123', '1q2w3e4r', '1234567890', 'dragon', 'baseball', 'football', 'letmein',
  'monkey', '696969', 'shadow', 'master', '666666', 'qwertyuiop', '123321', 'mustang',
  '1234567891', '000000', 'iloveyou', 'sunshine', 'princess', 'admin', 'welcome', 'solo',
  'abc123', 'passw0rd', 'starwars', 'trustno1', 'freedom', 'whatever', 'qazwsx', 'flower',
  '654321', 'jordan23', 'harley', 'password1', '1qaz2wsx', 'zxcvbnm', 'asdfghjkl', 'hunter',
  'ranger', 'buster', 'thomas', 'robert', 'soccer', 'hockey', 'killer', 'george', 'sexy',
  'andrew', 'charlie', 'superman', 'asshole', 'fuckyou', 'dallas', 'jessica', 'panties',
  'pepper', '1234', '696969', 'access', 'yankees', '987654321', 'dallas', 'austin', 'thunder',
  'taylor', 'matrix', 'mobilemail', 'mom', 'monitor', 'monopoly', 'montana', 'moon', 'moscow',
  'password123', 'passwords', 'pussy', 'pyramid', 'qazxsw', 'qqqqqq', 'qwer1234', 'qwerasdf',
  'qwertasdfg', 'qwertz', 'rabbit', 'racing', 'rainbow', 'rangers', 'rebel', 'redsox', 'robert',
  'rock', 'rocket', 'rosebud', 'runner', 'rush2112', 'russia', 'sammy', 'samsung', 'sandra',
  'saturn', 'scooby', 'scooter', 'scorpio', 'scorpion', 'shannon', 'shithead', 'silver',
  'skippy', 'slayer', 'smokey', 'snoopy', 'soccer', 'sparky', 'spider', 'sports', 'stanley',
  'star', 'startrek', 'starwars', 'starwars', 'steelers', 'steve', 'sticky', 'stupid', 'success',
  'summer', 'sunshine', 'superman', 'surfer', 'swimming', 'sydney', 'taylor', 'tennis',
  'tester', 'testing', 'tigers', 'tigger', 'top', 'topgun', 'toyota', 'travel', 'trouble',
  'trustno1', 'tucker', 'turtle', 'twitter', 'undertaker', 'united', 'vagina', 'video',
  'viking', 'voodoo', 'voyager', 'wallace', 'warrior', 'water', 'welcome', 'whatever',
  'william', 'willie', 'wilson', 'winner', 'winston', 'winter', 'wizard', 'wolf', 'yamaha',
  'yankee', 'yellow', 'zxcvbn', 'zzzzzz', 'q1w2e3r4', 'a1b2c3', 'aaaaaa', 'abcd1234',
  'abcdef', 'abcdefg', 'abcdefgh', 'access14', 'action', 'alexander', 'alpha', 'amanda',
  'american', 'angel', 'angela', 'animal', 'apollo', 'apple', 'arsenal', 'ashley', 'august',
  'aviation', 'badboy', 'banana', 'barcelona', 'baseball1', 'batman', 'beatles', 'beautiful',
  'beaver', 'beer', 'bigdaddy', 'bigdog', 'birthday', 'blazer', 'blessed', 'blondie',
  'bulldog', 'bullshit', 'butter', 'butterfly', 'calvin', 'cameron', 'cancer', 'captain',
  'carlos', 'casper', 'cat', 'catch22', 'charlie1', 'chelsea', 'chester', 'chicago', 'chicken',
  'chocolate', 'cocacola', 'coffee', 'college', 'compaq', 'computer', 'consumer', 'cookie',
  'cool', 'corvette', 'cowboy', 'cowboys', 'crystal', 'cumshot', 'dakota', 'dallas1',
  'danielle', 'diamond', 'diesel', 'disney', 'dolphin', 'dolphins', 'donald', 'dreams',
  'driver', 'eagle', 'eagle1', 'eagles', 'edward', 'einstein', 'elephant', 'elizabeth',
  'enter', 'enterprise', 'europe', 'extreme', 'falcon', 'family', 'fender', 'ferrari',
  'firebird', 'firebug', 'fishing', 'flowers', 'forever', 'forever1', 'fuckme', 'fuckoff',
  'gandalf', 'garfield', 'gateway', 'gators', 'gemini', 'genesis', 'ginger', 'godzilla',
  'golden', 'golfer', 'gordon', 'gregory', 'guitar', 'gunner', 'happy', 'hardcore', 'heather',
  'helpme', 'hello', 'hentai', 'hobbes', 'hockey', 'hooters', 'horney', 'horses', 'hotdog',
];

const COMMON_PASSWORDS_SET = new Set(COMMON_PASSWORDS.map((p) => p.toLowerCase()));

function isCommonPassword(password) {
  return COMMON_PASSWORDS_SET.has(String(password).toLowerCase());
}

module.exports = { isCommonPassword };
