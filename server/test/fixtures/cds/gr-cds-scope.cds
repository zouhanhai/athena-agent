@EndUserText.label: 'Consolidation Subitem'
@ObjectModel.usageType.size: #M
@ObjectModel.usageType.service: #X
@AbapCatalog.compiler.compareFilter: true
@AbapCatalog.defaultClient: '100'
define view I_CnsldtnSubitem_2
  as select from i_consolidationsubitem as ConsolidationSubitem
  association [1..1] to I_CnsldtnSubitmTx as _SubitemText
    on ConsolidationSubitem.CnsldtnSubitem = _SubitemText.CnsldtnSubitem
{
  key ConsolidationSubitem.CnsldtnSubitem,
      ConsolidationSubitem.CnsldtnSubitemName,
      _SubitemText.SubitemName
}
where ConsolidationSubitem.CnsldtnSubitem <> '';

@EndUserText.label: 'Consolidation Group'
@AbapCatalog.compiler.compareFilter: true
define view I_CnsldtnGroup
  as select from i_consolidationgroup as ConsolidationGroup
{
  key ConsolidationGroup.CnsldtnGroup,
      ConsolidationGroup.CnsldtnGroupName
};

@EndUserText.label: 'Consolidation of Investments Item'
@ObjectModel.usageType.size: #M
@ObjectModel.usageType.service: #X
@AbapCatalog.compiler.compareFilter: true
define view entity I_CnsldtnOfInvestmentsItem
  as select from i_consolidationofinvestments as ConsolidationOfInvestments
{
  key ConsolidationOfInvestments.CnsldtnOfInvestmentsItem,
      ConsolidationOfInvestments.FinStmtItem,
      ConsolidationOfInvestments.Amount
}
where ConsolidationOfInvestments.CnsldtnOfInvestmentsItem <> '';

@EndUserText.label: 'Company Code'
@AbapCatalog.compiler.compareFilter: true
define view entity I_CompanyCode
  as select from i_companycode as CompanyCode
{
  key CompanyCode.CompanyCode,
      CompanyCode.CompanyCodeName
};

@EndUserText.label: 'Consolidation Posting Item'
@ObjectModel.usageType.size: #M
@ObjectModel.usageType.service: #X
@AbapCatalog.compiler.compareFilter: true
define view I_CnsldtnPostingItem
  as select from i_consolidationpostingitem as ConsolidationPostingItem
  association [1..1] to I_CnsldtnGroup as _CnsldtnGroup
    on ConsolidationPostingItem.CnsldtnGroup = _CnsldtnGroup.CnsldtnGroup
  association [1..1] to I_CnsldtnSubitem_2 as _Subitem
    on ConsolidationPostingItem.CnsldtnSubitem = _Subitem.CnsldtnSubitem
{
  key ConsolidationPostingItem.CnsldtnPostingItem,
      ConsolidationPostingItem.CnsldtnSubitem,
      _CnsldtnGroup.CnsldtnGroupName,
      _Subitem.SubitemName
}
where ConsolidationPostingItem.CnsldtnPostingItem <> '';
