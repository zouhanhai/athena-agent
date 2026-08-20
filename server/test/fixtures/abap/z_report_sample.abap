REPORT z_report_sample.

START-OF-SELECTION.
  PERFORM initialize.
  PERFORM run_report.

FORM initialize.
  DATA lv_flag TYPE c.
  lv_flag = 'X'.
ENDFORM.

FORM run_report.
  SELECT * FROM mara INTO TABLE @DATA(lt_mara)
    UP TO 100 ROWS.
  PERFORM print_lines USING lt_mara.
ENDFORM.
