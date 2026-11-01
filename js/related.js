(function (root) {
  // Liste locale de termes proches. Ce n'est pas un modèle sémantique :
  // une formulation absente de cette liste n'est pas rapprochée.
  const GROUPS = [
    ["eau chaude", "ballon d'eau chaude", "ballon", "chauffe-eau", "chauffe eau", "douche froide", "douches froides"]
  ];

  function normalize(value) {
    return root.IPText.normalize(value);
  }

  function relatedPhrase(query, haystack) {
    const normQuery = normalize(query);
    const hay = normalize(haystack);
    if (!normQuery || !hay) return null;
    for (let g = 0; g < GROUPS.length; g += 1) {
      const terms = GROUPS[g].map(normalize).filter(Boolean).sort(function (a, b) {
        return b.length - a.length;
      });
      let matched = null;
      for (let i = 0; i < terms.length; i += 1) {
        if (normQuery.indexOf(terms[i]) !== -1) {
          matched = terms[i];
          break;
        }
      }
      if (!matched) continue;
      for (let i = 0; i < terms.length; i += 1) {
        if (terms[i] === matched) continue;
        if (hay.indexOf(terms[i]) !== -1) return GROUPS[g][0];
      }
    }
    return null;
  }

  root.IPRelated = {
    GROUPS: GROUPS,
    relatedPhrase: relatedPhrase
  };
})(globalThis);
