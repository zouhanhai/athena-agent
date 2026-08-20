CLASS zcl_fi_delivery DEFINITION
  PUBLIC SECTION.
    METHODS constructor.
    METHODS save.
    METHODS post.
ENDCLASS.

CLASS zcl_fi_delivery IMPLEMENTATION.
  METHOD constructor.
    SELECT SINGLE * FROM t001 INTO DATA(ls_company)
      WHERE bukrs = '1000'.
  ENDMETHOD.

  METHOD save.
    DATA(lt_items) = me->get_items( ).
    LOOP AT lt_items INTO DATA(ls_item).
      CALL FUNCTION 'Z_FI_POST'
        EXPORTING
          iv_amount = ls_item-amount.
    ENDLOOP.
  ENDMETHOD.

  METHOD post.
    SELECT * FROM vbap INTO TABLE @DATA(lt_sales).
    PERFORM validate_delivery USING lt_sales.
    CALL METHOD me->mark_complete.
  ENDMETHOD.
ENDCLASS.
