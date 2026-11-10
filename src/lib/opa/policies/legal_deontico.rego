package legal.deontico

import rego.v1

# Normalización y coincidencia léxica precisa (sin reglas catch-all)
split_words(text) := regex.split(`[\s,.;:()\[\]"'/\\\-]+`, lower(text))

word_matches(text_lower, word) if {
	count(word) >= 4
	contains(text_lower, word)
}

word_matches(text_lower, word) if {
	count(word) >= 7
	prefix := substring(word, 0, 6)
	contains(text_lower, prefix)
}

contains_term(text, term) if {
	term_clean := trim_space(lower(term))
	count(term_clean) >= 4
	contains(lower(text), term_clean)
}

contains_term(text, term) if {
	text_lower := lower(text)
	some tok in split_words(term)
	count(tok) >= 5
	word_matches(text_lower, tok)
}

contains_any(text, terms) if {
	some t in terms
	contains_term(text, t)
}

list_contains_any(arr, terms) if {
	some item in arr
	some t in terms
	contains_term(item, t)
}

# Extrae palabras clave de la regla o, en su ausencia, de los campos de la propia regla
rule_keywords(r) := kws if {
	raw := object.get(r, "palabras_clave", [])
	count(raw) > 0
	kws := raw
} else := [r.conducta, r.condicion, r.sujeto_normado, r.consecuencia]

# Coincidencia estricta basada en términos de la regla contra el contexto del caso
matches_obligation_context(omisiones, conductas, resumen, keywords) if {
	list_contains_any(omisiones, keywords)
}

matches_obligation_context(_, conductas, _, keywords) if {
	list_contains_any(conductas, keywords)
}

matches_obligation_context(_, _, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_prohibition_context(conductas, _, keywords) if {
	list_contains_any(conductas, keywords)
}

matches_prohibition_context(_, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_nullity_context(clausulas, _, keywords) if {
	list_contains_any(clausulas, keywords)
}

matches_nullity_context(_, resumen, keywords) if {
	contains_any(resumen, keywords)
}

matches_permission_context(sujetos, conductas, resumen, r, keywords) if {
	list_contains_any(sujetos, [r.sujeto_normado])
}

matches_permission_context(_, conductas, _, _, keywords) if {
	list_contains_any(conductas, keywords)
}

matches_permission_context(_, _, resumen, _, keywords) if {
	contains_any(resumen, keywords)
}

# 1. Incumplimientos de Obligación
incumplimientos_obligacion contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "OBLIGACION"

	omisiones := object.get(input, "omisiones_atribuidas", [])
	conductas := object.get(input, "conductas_relevantes", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := rule_keywords(r)

	matches_obligation_context(omisiones, conductas, resumen, keywords)

	msg := {
		"codigo": sprintf("OBL-%s", [r.id]),
		"veredicto_determinista": "INCUMPLIMIENTO_DE_DEBER_NORMATIVO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "OBLIGACION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Exigir el cumplimiento del deber '%s' asignado a '%s'. La inobservancia configura infracción con consecuencia jurídica: %s.", [r.conducta, r.sujeto_normado, r.consecuencia]),
	}
}

# 2. Violaciones a Prohibiciones
violaciones_prohibicion contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "PROHIBICION"

	conductas := object.get(input, "conductas_relevantes", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := rule_keywords(r)

	matches_prohibition_context(conductas, resumen, keywords)

	msg := {
		"codigo": sprintf("PROH-%s", [r.id]),
		"veredicto_determinista": "TRANSGRESION_DE_PROHIBICION_EXPRESA",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "PROHIBICION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Determinar la transgresión de la prohibición '%s' imputada a '%s'. Sanción / efecto aplicable: %s.", [r.conducta, r.sujeto_normado, r.consecuencia]),
	}
}

# 3. Cláusulas Inválidas o Sanciones de Nulidad
clausulas_invalidas contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad in {"SANCION_NULIDAD", "PROHIBICION"}

	clausulas := object.get(input, "clausulas_o_defensas_invocadas", [])
	count(clausulas) > 0
	resumen := object.get(input, "resumen_factico", "")
	keywords := rule_keywords(r)

	matches_nullity_context(clausulas, resumen, keywords)

	msg := {
		"codigo": sprintf("NUL-%s", [r.id]),
		"veredicto_determinista": "INEFICACIA_O_NULIDAD_DE_PLENO_DERECHO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": r.modalidad,
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("La estipulación o defensa invocada vulnera el precepto '%s'. Consecuencia determinista: %s.", [r.conducta, r.consecuencia]),
	}
}

# 4. Permisiones y Facultades Aplicables al Caso
permisiones_aplicables contains msg if {
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	some r in object.get(n, "deontic_rules", [])
	r.modalidad == "PERMISION"

	sujetos := object.get(input, "sujetos_involucrados", [])
	conductas := object.get(input, "conductas_relevantes", [])
	resumen := object.get(input, "resumen_factico", "")
	keywords := rule_keywords(r)

	matches_permission_context(sujetos, conductas, resumen, r, keywords)

	msg := {
		"codigo": sprintf("PERM-%s", [r.id]),
		"veredicto_determinista": "FACULTAD_O_DERECHO_RECONOCIDO",
		"fundamento_okf_id": n.okf_id,
		"modalidad": "PERMISION",
		"sujeto_normado": r.sujeto_normado,
		"conducta": r.conducta,
		"consecuencia": r.consecuencia,
		"directiva_redaccion": sprintf("Reconocer la facultad de '%s' para '%s' bajo el supuesto: %s.", [r.sujeto_normado, r.conducta, r.condicion]),
	}
}

# 5. Prelación Normativa Dinámica derivada de las normas cargadas y cláusulas del caso
loaded_laws := {law |
	some n in object.get(input, "nodos_cargados", [])
	n.status == "Vigente"
	law := object.get(n, "law_number", n.okf_id)
	law != ""
}

laws_summary := concat(", ", loaded_laws) if {
	count(loaded_laws) > 0
} else := "Normativa vigente cargada"

prelacion_kelsen := array.concat(
	[
		{
			"rango": 1,
			"nivel": sprintf("Marco Normativo Imperativo Cargado (%s)", [laws_summary]),
			"aplicacion": sprintf("Disposiciones vigentes evaluadas del documento (%d reglas activadas en obligaciones/prohibiciones/nulidades).", [count(incumplimientos_obligacion) + count(violaciones_prohibicion) + count(clausulas_invalidas)]),
		},
		{
			"rango": 2,
			"nivel": "Subsunción Deóntica sobre Hechos del Caso",
			"aplicacion": sprintf("Evaluación específica respecto de '%s' (%s) en relación con los nodos OKF implicados.", [object.get(input, "parte_evaluada", "parte evaluada"), object.get(input, "rol_o_condicion_juridica", "sujeto")]),
		},
	],
	clause_hierarchy_entries,
)

clause_hierarchy_entries := [
	{
		"rango": 3,
		"nivel": "Estipulaciones Particulares / Defensas Invocadas",
		"aplicacion": sprintf("Se analizaron %d defensa(s)/cláusula(s) frente al marco normativo: %d cuestionada(s) por invalidez o nulidad.", [count(object.get(input, "clausulas_o_defensas_invocadas", [])), count(clausulas_invalidas)]),
	},
] if {
	count(object.get(input, "clausulas_o_defensas_invocadas", [])) > 0
} else := []

# 6. Nodos OKF Obligatorios: estrictamente los nodos implicados por reglas activadas
nodos_okf_obligatorios contains item.fundamento_okf_id if {
	some item in incumplimientos_obligacion
}

nodos_okf_obligatorios contains item.fundamento_okf_id if {
	some item in violaciones_prohibicion
}

nodos_okf_obligatorios contains item.fundamento_okf_id if {
	some item in clausulas_invalidas
}

nodos_okf_obligatorios contains item.fundamento_okf_id if {
	some item in permisiones_aplicables
}

# 7. Términos de búsqueda obligatorios extraídos del caso
terminos_busqueda_obligatorios contains sprintf("%s %s", [object.get(input, "parte_evaluada", "parte"), object.get(input, "rol_o_condicion_juridica", "rol")])

# 8. Escenarios Contrafácticos Dinámicos generados a partir de los hallazgos activados
cf_obligaciones := [
	{
		"id": sprintf("CF-%s", [item.codigo]),
		"titulo": sprintf("Cumplimiento contrafáctico de %s (%s)", [item.fundamento_okf_id, item.codigo]),
		"hipotesis": sprintf("Si '%s' hubiera ejecutado la conducta debida: %s.", [item.sujeto_normado, item.conducta]),
		"regla_aplicable": sprintf("Se habría evitado el incumplimiento previsto en [%s], excluyendo la consecuencia: %s.", [item.fundamento_okf_id, item.consecuencia]),
	} |
	some item in incumplimientos_obligacion
]

cf_prohibiciones := [
	{
		"id": sprintf("CF-%s", [item.codigo]),
		"titulo": sprintf("Abstención contrafáctica de %s (%s)", [item.fundamento_okf_id, item.codigo]),
		"hipotesis": sprintf("Si '%s' se hubiera abstenido de la conducta vedada: %s.", [item.sujeto_normado, item.conducta]),
		"regla_aplicable": sprintf("No se habría configurado la transgresión a [%s] ni su sanción asociada: %s.", [item.fundamento_okf_id, item.consecuencia]),
	} |
	some item in violaciones_prohibicion
]

cf_nulidades := [
	{
		"id": sprintf("CF-%s", [item.codigo]),
		"titulo": sprintf("Validez sin cláusula contradictoria (%s)", [item.codigo]),
		"hipotesis": sprintf("Si las estipulaciones invocadas no contradijeran [%s] (%s).", [item.fundamento_okf_id, item.conducta]),
		"regla_aplicable": sprintf("La relación jurídica subsistiría sin activarse la consecuencia: %s.", [item.consecuencia]),
	} |
	some item in clausulas_invalidas
]

escenarios_contrafacticos := array.concat(cf_obligaciones, array.concat(cf_prohibiciones, cf_nulidades))
