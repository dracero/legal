package fiuba.legal.dictamen_test

import data.fiuba.legal.dictamen
import rego.v1

test_ruina_pba_subcontratista if {
	mock_input := {
		"rama_ingenieria": "Civil",
		"jurisdiccion": "PBA",
		"hay_ruina_o_impropiedad_obra": true,
		"anios_desde_recepcion": 3,
		"subcontratista_sin_matricula_verificada": true,
		"clausula_limitacion_o_dispensa": true,
		"matricula_jurisdiccion_activa": true,
		"modalidad_ejercicio": "profesional_liberal",
		"involucra_higiene_y_seguridad": false,
		"tarea_tecnica_critica": "fundaciones",
		"nodos_cargados": [
			{
				"okf_id": "norma-usuario-art-1",
				"title": "Ley de prueba cargada",
				"status": "Vigente",
				"especialidades_fiuba": ["Civil"],
				"jurisdiction": "PBA",
				"content": "Responsabilidad por vicios de suelo y control de subcontratista",
			},
		],
	}

	res_plazos := dictamen.evaluacion_plazos with input as mock_input
	res_plazos.en_plazo_garantia_decenal == true
	res_plazos.veredicto_determinista == "ACCION_DENTRO_DEL_PLAZO_DE_GARANTIA"

	nulas := dictamen.clausulas_nulas with input as mock_input
	count(nulas) == 1

	infracciones := dictamen.infracciones_ejercicio with input as mock_input
	count(infracciones) == 1

	obligatorios := dictamen.nodos_okf_obligatorios with input as mock_input
	"norma-usuario-art-1" in obligatorios
}
