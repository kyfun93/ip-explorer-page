(function (root) {
  const SERVICES = [
    { id: "voie", label: "VOIE" },
    { id: "mcbt", label: "MCBT" },
    { id: "emht", label: "EMHT" },
    { id: "ct", label: "CT" },
    { id: "eso", label: "ESO" },
    { id: "lem", label: "LEM" },
    { id: "gigp", label: "GIGP" }
  ];

  const SUB_ENTITIES = [
    { id: "voie_massy", serviceId: "voie", label: "Massy" },
    { id: "voie_nanterre", serviceId: "voie", label: "Nanterre" },
    { id: "voie_nogent", serviceId: "voie", label: "Nogent" },
    { id: "voie_republique", serviceId: "voie", label: "République" },
    { id: "voie_evs", serviceId: "voie", label: "EVS" },
    { id: "voie_villette", serviceId: "voie", label: "Villette" },
    { id: "mcbt_blr", serviceId: "mcbt", label: "BLR" },
    { id: "mcbt_vafo", serviceId: "mcbt", label: "VAFO" },
    { id: "mcbt_ntr4", serviceId: "mcbt", label: "NTR4" },
    { id: "emht_toul", serviceId: "emht", label: "Toul" },
    { id: "emht_epi_pht", serviceId: "emht", label: "EPI - PHT" },
    { id: "ct_bourdon_sig_3x8", serviceId: "ct", label: "Bourdon SIG 3×8" },
    { id: "ct_bourdon_sig", serviceId: "ct", label: "Bourdon SIG" },
    { id: "ct_ims_schematheque", serviceId: "ct", label: "IMS schémathèque" },
    { id: "ct_ims_vas", serviceId: "ct", label: "IMS VAS" },
    { id: "ct_ims_pst", serviceId: "ct", label: "IMS PST" },
    { id: "ct_denfert", serviceId: "ct", label: "Denfert" },
    { id: "ct_bourdon_mc", serviceId: "ct", label: "Bourdon MC" },
    { id: "ct_bourdon_log", serviceId: "ct", label: "Bourdon LOG" },
    { id: "ct_bourdon_esae_m", serviceId: "ct", label: "Bourdon ESAE M" },
    { id: "ct_nanterre", serviceId: "ct", label: "Nanterre" },
    { id: "ct_joinville", serviceId: "ct", label: "Joinville" },
    { id: "ct_blr", serviceId: "ct", label: "BLR" },
    { id: "eso_barbes", serviceId: "eso", label: "Barbès" },
    { id: "eso_csa", serviceId: "eso", label: "CSA" },
    { id: "eso_cpmo", serviceId: "eso", label: "CPMO" },
    { id: "eso_chanzy", serviceId: "eso", label: "Chanzy" },
    { id: "lem_boissy", serviceId: "lem", label: "Boissy" },
    { id: "gigp_blr", serviceId: "gigp", label: "BLR" },
    { id: "gigp_dulon", serviceId: "gigp", label: "DULON" },
    { id: "gigp_nogent", serviceId: "gigp", label: "Nogent" },
    { id: "gigp_l18", serviceId: "gigp", label: "L 18" }
  ];

  function serviceById(id) {
    return SERVICES.find(function (service) { return service.id === id; }) || null;
  }

  function serviceLabel(id) {
    const service = serviceById(id);
    return service ? service.label : "";
  }

  function subEntitiesFor(serviceId) {
    return SUB_ENTITIES.filter(function (item) { return item.serviceId === serviceId; });
  }

  function subEntityLabel(id) {
    const item = SUB_ENTITIES.find(function (entry) { return entry.id === id; });
    return item ? item.label : "";
  }

  const SERVICE_PROPOSALS = [
    { mention: "conduite du transport", serviceId: "ct", sourceLabel: "Conduite du transport" }
  ];

  function foldMention(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function proposalForMention(mention) {
    const folded = foldMention(mention);
    if (!folded) return null;
    const found = SERVICE_PROPOSALS.find(function (item) { return folded.indexOf(item.mention) !== -1; });
    return found || null;
  }

  root.IPReferential = {
    SERVICES: SERVICES,
    SUB_ENTITIES: SUB_ENTITIES,
    serviceById: serviceById,
    serviceLabel: serviceLabel,
    subEntitiesFor: subEntitiesFor,
    subEntityLabel: subEntityLabel,
    SERVICE_PROPOSALS: SERVICE_PROPOSALS,
    proposalForMention: proposalForMention
  };
})(globalThis);
