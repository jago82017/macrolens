// Reference data for the A–F diet-fit grades:
//   1. ADDITIVES: E-numbers with a concern tier, plain-English note and group.
//   2. Ingredient-text aliases, so additives can be found in ingredient lists (USDA branded, custom foods).
//   3. Ultra-processing markers used to estimate NOVA when Open Food Facts doesn't supply it.
//   4. Typical sugar / saturated fat / sodium / NOVA values for the built-in generic foods.
//
// Tiers: 0 = no known concern, 1 = low, 2 = moderate (best limited), 3 = high (avoid where you can).
// Notes summarise regulator positions (EFSA, UK FSA, US FDA, IARC) and widely cited studies. They are
// deliberately cautious: "linked to" means an association in studies, not proven harm at normal intake.

const SOUTHAMPTON = 'One of the "Southampton six" colours: UK/EU labels must warn it may affect activity and attention in children.';
const NITRITE = 'Nitrite/nitrate curing salt. Forms nitrosamines; processed meat cured with it is linked to bowel cancer (IARC Group 1).';
const BENZOATE = 'Can form benzene with vitamin C in drinks; linked to hyperactivity in some children.';
const SULPHITE = 'Sulphite. Can trigger asthma and reactions in sensitive people.';
const PHOSPHATE = 'Added phosphate. Absorbed far more than natural phosphorus; high intake is linked to heart and kidney strain.';
const POLYSORBATE = 'Emulsifier. Thinned the gut\'s protective mucus and drove inflammation in animal studies.';
const ALUMINIUM = 'Contains aluminium; total intake is best kept low.';
const GALLATE = 'Synthetic antioxidant; possible hormone-disrupting effects and skin sensitisation.';
const PARABEN = 'Paraben preservative; possible hormone-disrupting effects.';
const AZO = 'Synthetic azo dye; may cause intolerance in sensitive people and is banned in some countries.';
const MOD_STARCH = 'Modified starch. Considered safe, but a marker of ultra-processed food.';
const POLYOL = 'Sugar alcohol (polyol). Can cause bloating or a laxative effect in larger amounts.';
const GLUTAMATE = 'Flavour enhancer. Considered safe; a few people report sensitivity to large amounts.';
const EMULS_472 = 'Emulsifier ester. Generally regarded as safe at permitted levels.';

// code: [tier, name, group, note]
export const ADDITIVES = {
  // ---- Colours ----
  e100: [0, 'Curcumin', 'colour', 'Natural yellow from turmeric.'],
  e101: [0, 'Riboflavin (vitamin B2)', 'colour', 'A vitamin used as a yellow colour.'],
  e102: [3, 'Tartrazine', 'colour', SOUTHAMPTON],
  e104: [3, 'Quinoline yellow', 'colour', SOUTHAMPTON],
  e110: [3, 'Sunset yellow', 'colour', SOUTHAMPTON],
  e120: [1, 'Carmine (cochineal)', 'colour', 'Insect-derived red; can trigger allergies in a few people. Not vegetarian.'],
  e122: [3, 'Carmoisine', 'colour', SOUTHAMPTON],
  e123: [2, 'Amaranth', 'colour', 'Synthetic red banned as a food colour in the US; restricted in the UK/EU.'],
  e124: [3, 'Ponceau 4R', 'colour', SOUTHAMPTON],
  e127: [3, 'Erythrosine', 'colour', 'Caused thyroid tumours in rats; the US FDA banned it from food from 2027.'],
  e129: [3, 'Allura red', 'colour', SOUTHAMPTON],
  e131: [2, 'Patent blue V', 'colour', 'Synthetic dye; can cause allergic reactions in sensitive people.'],
  e132: [1, 'Indigo carmine', 'colour', 'Synthetic dye; considered safe at permitted levels.'],
  e133: [1, 'Brilliant blue', 'colour', 'Synthetic dye; considered safe at permitted levels.'],
  e140: [0, 'Chlorophylls', 'colour', 'Natural green from plants.'],
  e141: [0, 'Copper chlorophyllins', 'colour', 'Green colour derived from chlorophyll.'],
  e142: [2, 'Green S', 'colour', AZO],
  e150: [1, 'Caramel colour (type not stated)', 'colour', 'Some caramel types (E150c/d) can contain 4-MEI, a possible carcinogen.'],
  e150a: [0, 'Plain caramel', 'colour', 'Heated sugar; no known concern.'],
  e150b: [1, 'Caustic sulphite caramel', 'colour', 'Generally considered safe.'],
  e150c: [2, 'Ammonia caramel', 'colour', 'Can contain 4-MEI, a by-product IARC rates as possibly carcinogenic.'],
  e150d: [2, 'Sulphite ammonia caramel', 'colour', 'Used in colas. Can contain 4-MEI, a by-product IARC rates as possibly carcinogenic.'],
  e151: [2, 'Brilliant black', 'colour', AZO],
  e153: [1, 'Vegetable carbon', 'colour', 'Generally considered safe.'],
  e155: [2, 'Brown HT', 'colour', AZO],
  e160a: [0, 'Carotenes', 'colour', 'Natural orange (pro-vitamin A).'],
  e160b: [1, 'Annatto', 'colour', 'Natural colour; occasional allergic reactions.'],
  e160c: [0, 'Paprika extract', 'colour', 'Natural colour from peppers.'],
  e160d: [0, 'Lycopene', 'colour', 'Natural red from tomatoes.'],
  e160e: [0, 'Beta-apo-8\'-carotenal', 'colour', 'Carotenoid colour.'],
  e161b: [0, 'Lutein', 'colour', 'Natural carotenoid.'],
  e162: [0, 'Beetroot red', 'colour', 'Natural colour from beetroot.'],
  e163: [0, 'Anthocyanins', 'colour', 'Natural colours from berries and grapes.'],
  e170: [0, 'Calcium carbonate', 'other', 'Chalk; also a calcium source.'],
  e171: [3, 'Titanium dioxide', 'colour', 'Banned in EU food since 2022 over possible DNA damage; UK regulators still allow it.'],
  e172: [0, 'Iron oxides', 'colour', 'Mineral colours; no known concern at permitted levels.'],
  e173: [2, 'Aluminium', 'colour', ALUMINIUM],
  e174: [1, 'Silver', 'colour', 'Decorative metal; tiny amounts.'],
  e175: [0, 'Gold', 'colour', 'Decorative metal; inert.'],

  // ---- Preservatives ----
  e200: [0, 'Sorbic acid', 'preservative', 'Well-studied preservative; no known concern.'],
  e202: [0, 'Potassium sorbate', 'preservative', 'Well-studied preservative; no known concern.'],
  e203: [0, 'Calcium sorbate', 'preservative', 'Well-studied preservative; no known concern.'],
  e210: [2, 'Benzoic acid', 'preservative', BENZOATE],
  e211: [2, 'Sodium benzoate', 'preservative', BENZOATE],
  e212: [2, 'Potassium benzoate', 'preservative', BENZOATE],
  e213: [2, 'Calcium benzoate', 'preservative', BENZOATE],
  e214: [2, 'Ethylparaben', 'preservative', PARABEN],
  e215: [2, 'Sodium ethylparaben', 'preservative', PARABEN],
  e218: [2, 'Methylparaben', 'preservative', PARABEN],
  e219: [2, 'Sodium methylparaben', 'preservative', PARABEN],
  e220: [2, 'Sulphur dioxide', 'preservative', SULPHITE],
  e221: [2, 'Sodium sulphite', 'preservative', SULPHITE],
  e222: [2, 'Sodium bisulphite', 'preservative', SULPHITE],
  e223: [2, 'Sodium metabisulphite', 'preservative', SULPHITE],
  e224: [2, 'Potassium metabisulphite', 'preservative', SULPHITE],
  e226: [2, 'Calcium sulphite', 'preservative', SULPHITE],
  e227: [2, 'Calcium bisulphite', 'preservative', SULPHITE],
  e228: [2, 'Potassium bisulphite', 'preservative', SULPHITE],
  e234: [0, 'Nisin', 'preservative', 'Natural antimicrobial peptide.'],
  e235: [1, 'Natamycin', 'preservative', 'Antifungal used on cheese and sausage skins.'],
  e239: [2, 'Hexamine', 'preservative', 'Releases formaldehyde; restricted to certain cheeses.'],
  e242: [1, 'Dimethyl dicarbonate', 'preservative', 'Breaks down quickly in drinks.'],
  e249: [3, 'Potassium nitrite', 'preservative', NITRITE],
  e250: [3, 'Sodium nitrite', 'preservative', NITRITE],
  e251: [3, 'Sodium nitrate', 'preservative', NITRITE],
  e252: [3, 'Potassium nitrate', 'preservative', NITRITE],
  e260: [0, 'Acetic acid', 'acid', 'Vinegar acid.'],
  e261: [0, 'Potassium acetate', 'acid', 'No known concern.'],
  e262: [0, 'Sodium acetates', 'acid', 'No known concern.'],
  e263: [0, 'Calcium acetate', 'acid', 'No known concern.'],
  e270: [0, 'Lactic acid', 'acid', 'Produced naturally by fermentation.'],
  e280: [1, 'Propionic acid', 'preservative', 'Mould inhibitor in bread; some evidence of effects on insulin.'],
  e281: [1, 'Sodium propionate', 'preservative', 'Mould inhibitor in bread; some evidence of effects on insulin.'],
  e282: [1, 'Calcium propionate', 'preservative', 'Mould inhibitor in bread; some evidence of effects on insulin.'],
  e283: [1, 'Potassium propionate', 'preservative', 'Mould inhibitor in bread; some evidence of effects on insulin.'],
  e284: [2, 'Boric acid', 'preservative', 'Only allowed in caviar; toxic in larger doses.'],
  e285: [2, 'Sodium tetraborate (borax)', 'preservative', 'Only allowed in caviar; toxic in larger doses.'],
  e290: [0, 'Carbon dioxide', 'other', 'The fizz in drinks.'],
  e296: [0, 'Malic acid', 'acid', 'Natural fruit acid.'],
  e297: [0, 'Fumaric acid', 'acid', 'Natural acid.'],

  // ---- Antioxidants & acidity regulators ----
  e300: [0, 'Ascorbic acid (vitamin C)', 'antioxidant', 'Vitamin C.'],
  e301: [0, 'Sodium ascorbate', 'antioxidant', 'A form of vitamin C.'],
  e302: [0, 'Calcium ascorbate', 'antioxidant', 'A form of vitamin C.'],
  e304: [0, 'Ascorbyl palmitate', 'antioxidant', 'Fat-soluble vitamin C.'],
  e306: [0, 'Tocopherols (vitamin E)', 'antioxidant', 'Vitamin E.'],
  e307: [0, 'Alpha-tocopherol', 'antioxidant', 'Vitamin E.'],
  e308: [0, 'Gamma-tocopherol', 'antioxidant', 'Vitamin E.'],
  e309: [0, 'Delta-tocopherol', 'antioxidant', 'Vitamin E.'],
  e310: [2, 'Propyl gallate', 'antioxidant', GALLATE],
  e311: [2, 'Octyl gallate', 'antioxidant', GALLATE],
  e312: [2, 'Dodecyl gallate', 'antioxidant', GALLATE],
  e315: [0, 'Erythorbic acid', 'antioxidant', 'Close relative of vitamin C.'],
  e316: [0, 'Sodium erythorbate', 'antioxidant', 'Close relative of vitamin C.'],
  e319: [2, 'TBHQ', 'antioxidant', 'Synthetic antioxidant; high-dose animal studies raise concerns.'],
  e320: [3, 'BHA', 'antioxidant', 'Classed as possibly carcinogenic (IARC 2B); possible hormone disruptor.'],
  e321: [2, 'BHT', 'antioxidant', 'Mixed animal evidence; restricted in some countries.'],
  e322: [0, 'Lecithins', 'emulsifier', 'Natural emulsifier from soy, sunflower or egg.'],
  e325: [0, 'Sodium lactate', 'acid', 'No known concern.'],
  e326: [0, 'Potassium lactate', 'acid', 'No known concern.'],
  e327: [0, 'Calcium lactate', 'acid', 'No known concern.'],
  e330: [0, 'Citric acid', 'acid', 'Natural citrus acid.'],
  e331: [0, 'Sodium citrates', 'acid', 'No known concern.'],
  e332: [0, 'Potassium citrates', 'acid', 'No known concern.'],
  e333: [0, 'Calcium citrates', 'acid', 'No known concern.'],
  e334: [0, 'Tartaric acid', 'acid', 'Natural grape acid.'],
  e335: [0, 'Sodium tartrates', 'acid', 'No known concern.'],
  e336: [0, 'Potassium tartrates (cream of tartar)', 'acid', 'No known concern.'],
  e338: [2, 'Phosphoric acid', 'acid', 'Common in colas; high intake is linked to weaker bones and tooth erosion.'],
  e339: [2, 'Sodium phosphates', 'other', PHOSPHATE],
  e340: [2, 'Potassium phosphates', 'other', PHOSPHATE],
  e341: [2, 'Calcium phosphates', 'other', PHOSPHATE],
  e343: [2, 'Magnesium phosphates', 'other', PHOSPHATE],
  e385: [1, 'Calcium disodium EDTA', 'preservative', 'Binds metals; safe within limits.'],
  e392: [0, 'Rosemary extract', 'antioxidant', 'Natural antioxidant.'],

  // ---- Thickeners, stabilisers, emulsifiers ----
  e400: [0, 'Alginic acid', 'thickener', 'Seaweed-derived fibre.'],
  e401: [0, 'Sodium alginate', 'thickener', 'Seaweed-derived fibre.'],
  e402: [0, 'Potassium alginate', 'thickener', 'Seaweed-derived fibre.'],
  e404: [0, 'Calcium alginate', 'thickener', 'Seaweed-derived fibre.'],
  e405: [1, 'Propylene glycol alginate', 'thickener', 'Generally considered safe.'],
  e406: [0, 'Agar', 'thickener', 'Seaweed gel.'],
  e407: [2, 'Carrageenan', 'thickener', 'Linked to gut inflammation in animal and early human studies.'],
  e407a: [2, 'Processed eucheuma seaweed', 'thickener', 'A crude carrageenan; same gut concerns.'],
  e410: [0, 'Locust bean gum', 'thickener', 'Natural fibre from carob seeds.'],
  e412: [0, 'Guar gum', 'thickener', 'Natural soluble fibre.'],
  e413: [0, 'Tragacanth', 'thickener', 'Natural gum.'],
  e414: [0, 'Gum arabic', 'thickener', 'Natural gum; acts as fibre.'],
  e415: [0, 'Xanthan gum', 'thickener', 'Fermented fibre; no known concern.'],
  e416: [1, 'Karaya gum', 'thickener', 'Natural gum; occasional sensitivity.'],
  e417: [0, 'Tara gum', 'thickener', 'Natural gum.'],
  e418: [0, 'Gellan gum', 'thickener', 'Fermented gum; no known concern.'],
  e420: [1, 'Sorbitol', 'sweetener', POLYOL],
  e421: [1, 'Mannitol', 'sweetener', POLYOL],
  e422: [0, 'Glycerol', 'other', 'Humectant; no known concern.'],
  e425: [0, 'Konjac', 'thickener', 'Plant fibre.'],
  e432: [2, 'Polysorbate 20', 'emulsifier', POLYSORBATE],
  e433: [2, 'Polysorbate 80', 'emulsifier', POLYSORBATE],
  e434: [2, 'Polysorbate 40', 'emulsifier', POLYSORBATE],
  e435: [2, 'Polysorbate 60', 'emulsifier', POLYSORBATE],
  e436: [2, 'Polysorbate 65', 'emulsifier', POLYSORBATE],
  e440: [0, 'Pectins', 'thickener', 'Natural fruit fibre.'],
  e442: [1, 'Ammonium phosphatides', 'emulsifier', 'Used in chocolate; generally safe.'],
  e450: [2, 'Diphosphates', 'other', PHOSPHATE],
  e451: [2, 'Triphosphates', 'other', PHOSPHATE],
  e452: [2, 'Polyphosphates', 'other', PHOSPHATE],
  e460: [0, 'Cellulose', 'thickener', 'Plant fibre.'],
  e461: [1, 'Methyl cellulose', 'thickener', 'Modified cellulose; generally safe.'],
  e463: [1, 'Hydroxypropyl cellulose', 'thickener', 'Modified cellulose; generally safe.'],
  e464: [1, 'Hydroxypropyl methyl cellulose', 'thickener', 'Modified cellulose; generally safe.'],
  e466: [2, 'Carboxymethyl cellulose', 'emulsifier', 'Emulsifier; changed gut bacteria and metabolites in a human feeding trial.'],
  e470a: [0, 'Sodium/potassium/calcium salts of fatty acids', 'emulsifier', 'No known concern.'],
  e470b: [0, 'Magnesium salts of fatty acids', 'emulsifier', 'No known concern.'],
  e471: [2, 'Mono- and diglycerides of fatty acids', 'emulsifier', 'Very common emulsifier; a large 2023 French study linked higher intake to heart disease risk.'],
  e472a: [1, 'Acetic acid esters of mono-/diglycerides', 'emulsifier', EMULS_472],
  e472b: [1, 'Lactic acid esters of mono-/diglycerides', 'emulsifier', EMULS_472],
  e472c: [1, 'Citric acid esters of mono-/diglycerides', 'emulsifier', EMULS_472],
  e472e: [2, 'DATEM', 'emulsifier', 'Bread emulsifier; a large 2023 French study linked higher intake to heart disease risk.'],
  e472f: [1, 'Mixed esters of mono-/diglycerides', 'emulsifier', EMULS_472],
  e473: [1, 'Sucrose esters', 'emulsifier', 'Generally regarded as safe.'],
  e475: [1, 'Polyglycerol esters', 'emulsifier', 'Generally regarded as safe.'],
  e476: [1, 'PGPR', 'emulsifier', 'Used in chocolate to save cocoa butter; generally safe.'],
  e477: [1, 'Propylene glycol esters', 'emulsifier', 'Generally regarded as safe.'],
  e481: [1, 'Sodium stearoyl lactylate', 'emulsifier', 'Generally regarded as safe.'],
  e482: [1, 'Calcium stearoyl lactylate', 'emulsifier', 'Generally regarded as safe.'],
  e491: [1, 'Sorbitan monostearate', 'emulsifier', 'Generally regarded as safe.'],
  e492: [1, 'Sorbitan tristearate', 'emulsifier', 'Generally regarded as safe.'],

  // ---- Raising agents, minerals, anti-caking ----
  e500: [0, 'Sodium carbonates (baking soda)', 'raising', 'Raising agent.'],
  e501: [0, 'Potassium carbonates', 'raising', 'Raising agent.'],
  e503: [0, 'Ammonium carbonates', 'raising', 'Raising agent; breaks down in baking.'],
  e504: [0, 'Magnesium carbonates', 'other', 'No known concern.'],
  e507: [0, 'Hydrochloric acid', 'acid', 'Processing aid.'],
  e508: [0, 'Potassium chloride', 'other', 'Salt substitute.'],
  e509: [0, 'Calcium chloride', 'other', 'Firming agent.'],
  e511: [0, 'Magnesium chloride', 'other', 'Firming agent (tofu).'],
  e516: [0, 'Calcium sulphate', 'other', 'Firming agent (tofu).'],
  e520: [2, 'Aluminium sulphate', 'other', ALUMINIUM],
  e521: [2, 'Aluminium sodium sulphate', 'other', ALUMINIUM],
  e523: [2, 'Aluminium ammonium sulphate', 'other', ALUMINIUM],
  e524: [0, 'Sodium hydroxide', 'acid', 'Processing aid.'],
  e530: [0, 'Magnesium oxide', 'other', 'No known concern.'],
  e535: [1, 'Sodium ferrocyanide', 'other', 'Anti-caking agent in salt; tiny amounts.'],
  e536: [1, 'Potassium ferrocyanide', 'other', 'Anti-caking agent in salt; tiny amounts.'],
  e541: [2, 'Sodium aluminium phosphate', 'raising', ALUMINIUM],
  e551: [1, 'Silicon dioxide', 'other', 'Anti-caking agent; nano-sized forms are under review.'],
  e552: [1, 'Calcium silicate', 'other', 'Anti-caking agent.'],
  e553b: [1, 'Talc', 'other', 'Anti-caking agent.'],
  e554: [2, 'Sodium aluminium silicate', 'other', ALUMINIUM],
  e555: [2, 'Potassium aluminium silicate', 'other', ALUMINIUM],
  e556: [2, 'Calcium aluminium silicate', 'other', ALUMINIUM],
  e559: [2, 'Aluminium silicate', 'other', ALUMINIUM],
  e570: [0, 'Fatty acids', 'other', 'No known concern.'],
  e575: [0, 'Glucono-delta-lactone', 'acid', 'No known concern.'],
  e579: [0, 'Ferrous gluconate', 'colour', 'Iron salt.'],
  e585: [0, 'Ferrous lactate', 'colour', 'Iron salt.'],

  // ---- Flavour enhancers ----
  e620: [1, 'Glutamic acid', 'flavour', GLUTAMATE],
  e621: [1, 'Monosodium glutamate (MSG)', 'flavour', GLUTAMATE],
  e622: [1, 'Monopotassium glutamate', 'flavour', GLUTAMATE],
  e627: [1, 'Disodium guanylate', 'flavour', 'Flavour enhancer usually paired with MSG.'],
  e631: [1, 'Disodium inosinate', 'flavour', 'Flavour enhancer usually paired with MSG.'],
  e635: [1, 'Disodium ribonucleotides', 'flavour', 'Flavour enhancer; occasional itchy rash reported.'],
  e640: [0, 'Glycine', 'flavour', 'An amino acid.'],

  // ---- Glazes, gases, misc ----
  e900: [1, 'Dimethylpolysiloxane', 'other', 'Anti-foaming agent; generally safe.'],
  e901: [0, 'Beeswax', 'other', 'Glazing agent.'],
  e903: [0, 'Carnauba wax', 'other', 'Glazing agent.'],
  e904: [0, 'Shellac', 'other', 'Glazing agent.'],
  e905: [1, 'Microcrystalline wax', 'other', 'Petroleum-derived glazing agent.'],
  e920: [0, 'L-cysteine', 'other', 'Flour treatment amino acid.'],
  e938: [0, 'Argon', 'other', 'Packaging gas.'],
  e941: [0, 'Nitrogen', 'other', 'Packaging gas.'],
  e942: [0, 'Nitrous oxide', 'other', 'Propellant in squirty cream.'],
  e948: [0, 'Oxygen', 'other', 'Packaging gas.'],

  // ---- Sweeteners ----
  e950: [2, 'Acesulfame K', 'sweetener', 'Artificial sweetener; animal studies suggest effects on gut bacteria and metabolism.'],
  e951: [2, 'Aspartame', 'sweetener', 'Artificial sweetener; IARC classed it possibly carcinogenic (2B) in 2023, though still approved within limits.'],
  e952: [2, 'Cyclamates', 'sweetener', 'Artificial sweetener banned in the US; allowed in the UK/EU.'],
  e953: [1, 'Isomalt', 'sweetener', POLYOL],
  e954: [2, 'Saccharin', 'sweetener', 'Artificial sweetener; may alter gut bacteria and blood sugar response.'],
  e955: [2, 'Sucralose', 'sweetener', 'Artificial sweetener; 2023 lab studies raised concerns about a breakdown product.'],
  e957: [0, 'Thaumatin', 'sweetener', 'Natural sweet protein.'],
  e959: [1, 'Neohesperidin DC', 'sweetener', 'Citrus-derived sweetener.'],
  e960: [1, 'Steviol glycosides (stevia)', 'sweetener', 'Plant-derived sweetener; generally regarded as safe.'],
  e961: [2, 'Neotame', 'sweetener', 'Artificial sweetener related to aspartame.'],
  e962: [2, 'Aspartame-acesulfame salt', 'sweetener', 'Combination of two artificial sweeteners.'],
  e964: [1, 'Polyglycitol syrup', 'sweetener', POLYOL],
  e965: [1, 'Maltitol', 'sweetener', POLYOL],
  e966: [1, 'Lactitol', 'sweetener', POLYOL],
  e967: [2, 'Xylitol', 'sweetener', 'A 2024 study linked high blood levels to clotting and heart events; laxative in large amounts.'],
  e968: [2, 'Erythritol', 'sweetener', 'A 2023 study linked high blood levels to clotting and heart attack risk.'],
  e969: [1, 'Advantame', 'sweetener', 'Artificial sweetener used in tiny amounts.'],

  // ---- Modified starches & carriers ----
  e1404: [1, 'Oxidised starch', 'thickener', MOD_STARCH],
  e1410: [1, 'Monostarch phosphate', 'thickener', MOD_STARCH],
  e1412: [1, 'Distarch phosphate', 'thickener', MOD_STARCH],
  e1413: [1, 'Phosphated distarch phosphate', 'thickener', MOD_STARCH],
  e1414: [1, 'Acetylated distarch phosphate', 'thickener', MOD_STARCH],
  e1420: [1, 'Acetylated starch', 'thickener', MOD_STARCH],
  e1422: [1, 'Acetylated distarch adipate', 'thickener', MOD_STARCH],
  e1440: [1, 'Hydroxypropyl starch', 'thickener', MOD_STARCH],
  e1442: [1, 'Hydroxypropyl distarch phosphate', 'thickener', MOD_STARCH],
  e1450: [1, 'Starch sodium octenyl succinate', 'thickener', MOD_STARCH],
  e1451: [1, 'Acetylated oxidised starch', 'thickener', MOD_STARCH],
  e1505: [1, 'Triethyl citrate', 'other', 'Flavour carrier; generally safe.'],
  e1518: [1, 'Triacetin', 'other', 'Flavour carrier; generally safe.'],
  e1520: [1, 'Propylene glycol', 'other', 'Flavour carrier; safe within limits.'],
};

// Plain-English names that appear in ingredient lists (mostly US/UK labels) → code.
// Matched case-insensitively on word boundaries. Longer phrases are tried first.
export const ADDITIVE_ALIASES = {
  'tartrazine': 'e102', 'yellow 5': 'e102', 'yellow no. 5': 'e102',
  'quinoline yellow': 'e104',
  'sunset yellow': 'e110', 'yellow 6': 'e110', 'yellow no. 6': 'e110',
  'carmine': 'e120', 'cochineal': 'e120',
  'carmoisine': 'e122', 'azorubine': 'e122',
  'ponceau 4r': 'e124',
  'erythrosine': 'e127', 'red 3': 'e127', 'red no. 3': 'e127',
  'allura red': 'e129', 'red 40': 'e129', 'red no. 40': 'e129',
  'patent blue': 'e131',
  'indigo carmine': 'e132', 'blue 2': 'e132',
  'brilliant blue': 'e133', 'blue 1': 'e133', 'blue no. 1': 'e133',
  'caramel colour': 'e150', 'caramel color': 'e150', 'caramel colouring': 'e150', 'caramel coloring': 'e150',
  'titanium dioxide': 'e171',
  'potassium sorbate': 'e202', 'sorbic acid': 'e200',
  'benzoic acid': 'e210', 'sodium benzoate': 'e211', 'potassium benzoate': 'e212',
  'sulphur dioxide': 'e220', 'sulfur dioxide': 'e220',
  'sodium metabisulphite': 'e223', 'sodium metabisulfite': 'e223',
  'potassium metabisulphite': 'e224', 'potassium metabisulfite': 'e224',
  'sodium sulphite': 'e221', 'sodium sulfite': 'e221', 'sodium bisulfite': 'e222',
  'potassium nitrite': 'e249', 'sodium nitrite': 'e250', 'sodium nitrate': 'e251', 'potassium nitrate': 'e252',
  'calcium propionate': 'e282', 'sodium propionate': 'e281',
  'propyl gallate': 'e310',
  'tbhq': 'e319', 'tertiary butylhydroquinone': 'e319',
  'bha': 'e320', 'butylated hydroxyanisole': 'e320',
  'bht': 'e321', 'butylated hydroxytoluene': 'e321',
  'phosphoric acid': 'e338',
  'sodium phosphate': 'e339', 'disodium phosphate': 'e339', 'trisodium phosphate': 'e339', 'monosodium phosphate': 'e339',
  'potassium phosphate': 'e340', 'dipotassium phosphate': 'e340',
  'calcium phosphate': 'e341', 'tricalcium phosphate': 'e341',
  'sodium acid pyrophosphate': 'e450', 'tetrasodium pyrophosphate': 'e450', 'diphosphates': 'e450',
  'sodium tripolyphosphate': 'e451', 'sodium hexametaphosphate': 'e452', 'polyphosphates': 'e452',
  'calcium disodium edta': 'e385',
  'carrageenan': 'e407',
  'polysorbate 80': 'e433', 'polysorbate 60': 'e435', 'polysorbate 20': 'e432',
  'carboxymethylcellulose': 'e466', 'carboxymethyl cellulose': 'e466', 'cellulose gum': 'e466',
  'mono- and diglycerides': 'e471', 'mono and diglycerides': 'e471', 'mono- and di-glycerides': 'e471', 'monoglycerides': 'e471',
  'datem': 'e472e',
  'acesulfame k': 'e950', 'acesulfame potassium': 'e950', 'acesulfame': 'e950',
  'aspartame': 'e951',
  'saccharin': 'e954',
  'sucralose': 'e955',
  'steviol glycosides': 'e960', 'stevia': 'e960',
  'erythritol': 'e968', 'xylitol': 'e967', 'sorbitol': 'e420', 'maltitol': 'e965', 'isomalt': 'e953',
  'monosodium glutamate': 'e621', 'msg': 'e621',
  'disodium inosinate': 'e631', 'disodium guanylate': 'e627',
  'xanthan gum': 'e415', 'guar gum': 'e412', 'gellan gum': 'e418', 'locust bean gum': 'e410', 'gum arabic': 'e414',
  'soy lecithin': 'e322', 'soya lecithin': 'e322', 'sunflower lecithin': 'e322', 'lecithin': 'e322',
  'citric acid': 'e330', 'ascorbic acid': 'e300', 'sodium erythorbate': 'e316',
  'pectin': 'e440',
  'modified starch': 'e1422', 'modified corn starch': 'e1422', 'modified maize starch': 'e1422', 'modified food starch': 'e1422', 'modified tapioca starch': 'e1422',
  'silicon dioxide': 'e551',
  'sodium aluminium phosphate': 'e541', 'sodium aluminum phosphate': 'e541',
};

// Ingredients that only show up in industrial (NOVA 4) food. Used when Open Food Facts doesn't give a NOVA group.
export const UPF_MARKERS = [
  'glucose syrup', 'glucose-fructose syrup', 'fructose-glucose syrup', 'high fructose corn syrup', 'corn syrup', 'invert sugar',
  'maltodextrin', 'dextrose', 'hydrogenated', 'interesterified', 'protein isolate', 'whey isolate', 'hydrolysed', 'hydrolyzed',
  'flavouring', 'flavoring', 'natural flavour', 'natural flavor', 'artificial flavour', 'artificial flavor', 'modified starch',
  'modified corn starch', 'modified maize starch', 'modified food starch', 'emulsifier', 'sweetener', 'colour:', 'color:',
  'humectant', 'glazing agent', 'flavour enhancer', 'flavor enhancer', 'mechanically separated',
];

// Additive groups whose presence alone marks a food as ultra-processed (NOVA's own rule of thumb).
export const UPF_GROUPS = new Set(['sweetener', 'emulsifier', 'flavour']);
export const UPF_COLOUR_TIER = 1; // any colour at tier ≥ 1 (synthetic/cosmetic) also counts

// ---- Built-in foods: typical sugar (g), saturated fat (g), sodium (mg) per 100 g, and NOVA group ----
// These are approximations for generic versions of each food. Scanned products always use their real data.
const BUILTIN_TABLE = `
apple 10.4 0 1 1|banana 12.2 0.1 1 1|orange 9.4 0 0 1|strawberries 4.9 0 1 1|blueberries 10 0 1 1|raspberries 4.4 0 1 1
grapes 15.5 0.1 2 1|watermelon 6.2 0 1 1|pineapple 9.9 0 1 1|mango 13.7 0.1 1 1|avocado 0.7 2.1 7 1|pear 9.8 0 1 1
peach 8.4 0 0 1|kiwi 9 0 3 1|cherries 12.8 0 0 1|fruitsalad 11 0 3 1
broccoli 1.7 0 33 1|carrots 4.7 0 69 1|greens 1.2 0 28 1|tomato 2.6 0 5 1|cucumber 1.7 0 2 1|spinach 0.4 0.1 70 1
corn 4.5 0.2 15 1|greenbeans 3.3 0 6 1|peas 5.7 0.1 5 1|bellpepper 4.2 0 4 1|mushrooms 2 0 5 1|asparagus 1.9 0 2 1
cauliflower 1.9 0.1 30 1|roastveg 4.5 0.5 250 1|potato 0.8 0 6 1|sweetpotato 4.2 0 36 1|mash 1.5 2.5 300 1|edamame 2.2 0.6 6 1
guacamole 1 2.1 240 1
rice 0.1 0.1 1 1|brownrice 0.4 0.3 4 1|pasta 0.6 0.2 1 1|bread 5 0.7 490 3|wholebread 4.5 0.7 450 3|toast 4 6 450 3
bagel 6 0.3 440 3|croissant 11 12 380 3|oatmeal 0.5 0.3 50 1|granola 24 4 30 3|cereal 8 0.8 120 4|quinoa 0.9 0.2 7 1
couscous 0.1 0 5 1|noodles 0.4 0.4 5 1|tortilla 3 2.5 600 4|naan 3 1.5 420 3|garlicbread 3 7 500 3|pancakes 6 2 450 3
waffles 5 3 510 3|frenchtoast 5 3 480 3|avotoast 1.5 1.8 300 3|eggsbenedict 1.5 6 480 3|fullbreakfast 2 4.5 600 3
breakfastburrito 2 4 520 3|huevos 3 2.5 380 1|smoothiebowl 13 1 20 1|yogurt 13 1.3 50 4|greekyogurt 3.6 1.2 35 1
chicken 0 1 74 1|friedchicken 0.3 4 600 3|wings 0.5 5.5 450 3|roastchicken 0 3.5 80 1|nuggets 0.5 3.5 550 4|teriyaki 6 1.5 700 3
steak 0 6.5 55 1|filet 0 4.7 55 1|primerib 0 11 60 1|beefmince 0 6.7 70 1|ribs 6 7 500 3|porkchop 0 4.5 60 1
bacon 1.4 14 1700 3|sausage 1 9.5 800 4|ham 1 1.8 1200 3|lamb 0 7 70 1|turkey 0 0.8 65 1|duck 7 4.5 500 3
meatballs 1.5 6 500 3|salmon 0 2.5 60 1|tuna 0 0.3 300 3|whitefish 0 0.2 80 1|shrimp 0 0.1 120 1|calamari 0.5 1.5 300 3
lobster 0 0.2 300 1|crab 0 0.2 300 1|crabcakes 1 2.5 600 3|oysters 0 0.4 210 1|mussels 0 0.9 370 1|scallops 0 0.1 400 1
friedegg 0.4 4.3 210 1|boiledegg 1.1 3.3 125 1|scrambled 1.4 3.3 145 1|omelette 0.6 3.3 155 1|devilled 0.8 3.2 270 1
tofu 0.6 1.3 10 1|beans 0.3 0.1 100 1|lentils 1.8 0.1 2 1|chickpeas 4.8 0.3 7 1|hummus 0.3 1.4 400 3|falafel 2 2.5 300 3
cottage 2.7 1.7 360 3|cheddar 0.5 19 650 3|mozzarella 1 10 500 3|cheeseplate 1.5 15 700 3|milk 5 1.2 43 1|proteinshake 2 0.5 60 4
pb 9 10 430 3|almonds 4.4 3.8 1 1|nuts 4.5 7 300 3|chips 0.5 3.5 525 4|popcorn 0.5 2.5 500 4|pretzels 2.8 0.6 1300 3
crackers 6 3 800 4|ricecakes 0.9 0.6 30 3|proteinbar 15 5 250 4|granolabar 25 6 250 4|chocolate 52 18 80 4
pizza 3.6 4.5 600 3|pepperonipizza 3.5 5.5 680 3|burger 5 4.5 500 4|cheeseburger 5 5.5 550 4|hotdog 4 5.5 750 4|fries 0.3 2.3 210 3
onionrings 4 3 400 4|poutine 1 5 500 3|sandwich 3 2.5 700 3|clubsandwich 3 3.5 750 3|grilledcheese 4 10 800 3|pulledpork 8 3 600 3
lobsterroll 3 2.5 600 3|croque 3 7 800 3|wrap 2 2.5 550 3|burrito 1.5 3 500 3|burritobowl 1.5 2 400 1|tacos 1.5 4.5 400 3
nachos 2 7 500 3|quesadilla 2 8 600 3|gyro 2 3.5 550 3|sushi 7 0.3 450 3|sashimi 0 1 50 1|poke 4 0.7 400 3
ramen 1 1.5 550 3|pho 1 0.5 400 1|padthai 9 1.2 600 3|friedrice 1.5 1 450 3|chowmein 3 1 550 3|stirfry 3 1 450 1
dumplings 2 2.5 500 3|springrolls 3 2.5 450 3|bibimbap 3 0.8 350 1|misosoup 1 0.3 750 3|takoyaki 3 2 450 3|seaweedsalad 7 0.4 700 3
curry 2 3 450 1|curryrice 1.5 2 350 1|tikka 3 3.5 450 3|butterchicken 3.5 5 450 3|biryani 1 2 400 1|samosa 2 3 400 3
paella 1 1 450 1|risotto 1 3 380 1|bolognese 3 1.8 280 1|carbonara 1 4 380 1|lasagna 3 3 380 3|macncheese 2.5 3.5 500 3
ravioli 2 3 400 3|gnocchi 1 0.5 400 3|caesar 1.5 3 400 3|greeksalad 2.5 3.5 450 3|chickensalad 2 1 250 1|caprese 2.5 8 300 3
beetsalad 6 1.8 250 1|bruschetta 3 1 350 3|ceviche 1.5 0.2 400 1|tartare 1 1 300 1|beeftartare 1 4 300 1|fishchips 0.5 2 300 3
shrimpgrits 1 2.5 450 3|chili 2.5 1.5 400 1|stew 1.5 1.5 300 1|shepherdspie 1.5 2.5 300 1|vegsoup 2 0.1 300 1|chickensoup 0.5 0.3 340 3
tomatosoup 4 0.3 400 3|chowder 1 2.5 380 3|onionsoup 2 1.8 400 3|bisque 1.5 4.5 450 3|hotsour 0.7 0.3 400 3
cheesecake 22 12 300 4|chococake 36 5.5 300 4|carrotcake 33 4 350 3|redvelvet 38 4 300 4|shortcake 20 6 250 3|cupcake 40 6 300 4
donut 23 11 340 4|brownie 38 7 230 4|cookies 35 11 330 4|muffin 28 3 320 4|cinnamonroll 25 4 380 4|icecream 21 7 80 4
froyo 20 2 60 4|applepie 16 4 260 3|tiramisu 22 9 70 3|macarons 50 3 30 4|churros 18 5 300 3|cremebrulee 24 11 50 3
pannacotta 20 9 40 3|mousse 18 9 50 3|baklava 22 10 260 3|cannoli 20 9 120 3|beignets 15 6 350 3|breadpudding 18 3 270 3
coffee 0 0 2 1|latte 5 1.1 40 1|oj 8.4 0 1 1|smoothie 11 0.1 5 1|milkshake 18 2.4 80 4|soda 10.6 0 4 4
beer 0 0 4 3|wine 0.6 0 4 3`;

export const BUILTIN_EXTRA = Object.fromEntries(
  BUILTIN_TABLE.trim().split(/[|\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const [key, sugar, satFat, sodium, nova] = s.split(/\s+/);
    return [key, { sugar: +sugar, satFat: +satFat, sodium: +sodium, nova: +nova }];
  }),
);

// Built-in foods with special handling.
export const PROCESSED_MEAT = new Set(['bacon', 'sausage', 'ham', 'hotdog', 'pepperonipizza', 'sandwich', 'clubsandwich', 'croque', 'fullbreakfast', 'carbonara']);
export const DEEP_FRIED = new Set(['friedchicken', 'nuggets', 'fries', 'onionrings', 'calamari', 'fishchips', 'churros', 'donut', 'springrolls', 'samosa', 'falafel', 'beignets', 'chips', 'takoyaki']);
export const FREE_SUGAR_FRUIT = new Set(['oj', 'smoothie', 'smoothiebowl']); // juiced or blended fruit counts as free sugar
export const ALCOHOL = new Set(['beer', 'wine']);
export const PLAIN_DAIRY = new Set(['milk', 'greekyogurt', 'cottage', 'latte']);
