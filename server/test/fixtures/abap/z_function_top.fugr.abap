FUNCTION-POOL z_function_top.
INCLUDE z_function_top_top.                       " global data
INCLUDE z_function_top_u01.                       " Z_FI_POST

FUNCTION z_fi_post.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(IV_AMOUNT) TYPE  WERTV9
*"     VALUE(IV_COMPANY) TYPE  BUKRS DEFAULT '1000'
*"  EXPORTING
*"     VALUE(EV_DOCNO) TYPE  BELNR
*"----------------------------------------------------------------------
  SELECT SINGLE * FROM bkpf INTO @DATA(ls_bkpf).
  EV_DOCNO = ls_bkpf-belnr.
ENDFUNCTION.

FUNCTION z_fi_check_release.
  SELECT COUNT(*) FROM vbak.
  IF sy-subrc = 0.
  ENDIF.
ENDFUNCTION.
