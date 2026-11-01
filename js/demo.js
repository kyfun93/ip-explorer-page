(function (root) {
  const added = "2026-10-31T08:00:00.000Z";
  root.IPDemo = {
    questions: [
      {
        id: "demo-ballon",
        origin: "demo",
        question: "Exemple fictif : le ballon d’eau chaude du local est en panne depuis lundi.",
        answer: "Exemple fictif : un dépannage est prévu. Ceci n’est pas une réponse réelle.",
        number: "1",
        organization: "CGT",
        serviceId: "voie",
        serviceMention: null,
        subEntityId: "voie_villette",
        place: null,
        meetingDate: "2026-02-06",
        addedAt: added,
        updatedAt: added,
        provenance: []
      },
      {
        id: "demo-chauffe",
        origin: "demo",
        question: "Exemple fictif : le chauffe-eau du vestiaire ne produit plus rien.",
        answer: "Exemple fictif : pièce commandée. Ceci n’est pas une réponse réelle.",
        number: null,
        organization: null,
        serviceId: "eso",
        serviceMention: null,
        subEntityId: null,
        place: "Vestiaire",
        meetingDate: "2025-11-14",
        addedAt: added,
        updatedAt: added,
        provenance: []
      },
      {
        id: "demo-nuit",
        origin: "demo",
        question: "Exemple fictif : les créneaux de nuit manquent d’effectifs.",
        answer: "Exemple fictif : point noté au suivi.",
        number: "4",
        organization: "UNSA",
        serviceId: "ct",
        serviceMention: null,
        subEntityId: null,
        place: null,
        meetingDate: "2024-03-02",
        addedAt: "2026-10-30T08:00:00.000Z",
        updatedAt: "2026-10-30T08:00:00.000Z",
        provenance: []
      }
    ]
  };
})(globalThis);
